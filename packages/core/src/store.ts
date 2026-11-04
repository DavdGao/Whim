import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';

import { StoreError } from './commands.js';
import { requestSchema, responseSchema } from './protocol.js';

import type { TranscriptPage } from './presentation.js';
import type { WorkerRequest } from './protocol.js';
import type { AgentRecord, AgentStore, Command } from './records.js';

/** Own the database worker; no synchronous SQLite call runs on the caller's thread. */
export class SqliteStore implements AgentStore {
    private readonly worker: Worker;
    private readonly pending = new Map<
        string,
        {
            resolve: (result: {
                records: AgentRecord[];
                locale?: 'en' | 'zh-CN';
                transcript?: TranscriptPage;
                artifact?: { id: string; name: string; mediaType: string; data: string };
            }) => void;
            reject: (error: Error) => void;
        }
    >();
    private closing = false;
    private failure: Error | null = null;
    private readonly ready: Promise<void>;
    private readonly exited: Promise<void>;

    /**
     * Start the worker; use open() to await initialization and migration errors.
     * @param path The SQLite database path.
     * @param nativeBinding
     */
    private constructor(path: string, nativeBinding?: string) {
        this.worker = new Worker(new URL('./worker.js', import.meta.url), {
            workerData: { path, ...(nativeBinding ? { nativeBinding } : {}) },
        });
        this.exited = new Promise(resolve => this.worker.once('exit', () => resolve()));
        this.ready = new Promise((resolve, reject) => {
            this.worker.on('message', (input: unknown) => {
                const parsed = responseSchema.safeParse(input);
                if (!parsed.success) {
                    const error = new Error('Invalid database worker response.');
                    this.fail(error);
                    reject(error);
                    void this.worker.terminate().catch(() => undefined);
                    return;
                }
                const response = parsed.data;
                if (response.type === 'ready') {
                    resolve();
                    return;
                }
                const pending = this.pending.get(response.id);
                this.pending.delete(response.id);
                if (response.type === 'error')
                    pending?.reject(new StoreError(response.code, response.message));
                else pending?.resolve(response);
            });
            this.worker.on('error', error => {
                this.fail(error);
                reject(error);
            });
            this.worker.on('exit', code => {
                const error = new Error(`Database worker exited (${code}).`);
                this.fail(error);
                reject(error);
            });
        });
    }

    /**
     * Open one database and wait until its worker is ready.
     * @param path The SQLite database path.
     * @param nativeBinding
     * @returns The initialized store.
     */
    static async open(path: string, nativeBinding?: string): Promise<SqliteStore> {
        const store = new SqliteStore(path, nativeBinding);
        await store.ready;
        return store;
    }

    /**
     * Validate a command and commit its complete batch or reject without any append.
     * @param command The requested journal transition.
     * @returns The original receipt records on an idempotent retry.
     */
    async execute(command: Command): Promise<AgentRecord[]> {
        return (await this.send({ type: 'execute', id: randomUUID(), command })).records;
    }

    /**
     * Read the immutable journal in session sequence order.
     * @param sessionId The target session identity.
     * @param afterSeq
     * @returns The complete ordered journal.
     */
    async read(sessionId: string, afterSeq?: string): Promise<AgentRecord[]> {
        return (
            await this.send({
                type: 'read',
                id: randomUUID(),
                sessionId,
                ...(afterSeq ? { afterSeq } : {}),
            })
        ).records;
    }

    /**
     * Query session creation records and persist the application language preference.
     * @returns Session discovery records and persisted preferences.
     * @param locale
     */
    async application(locale?: 'en' | 'zh-CN'): Promise<{
        records: AgentRecord[];
        locale?: 'en' | 'zh-CN';
        transcript?: TranscriptPage;
        artifact?: { id: string; name: string; mediaType: string; data: string };
    }> {
        return this.send({ type: 'application', id: randomUUID(), ...(locale ? { locale } : {}) });
    }

    /** Query a bounded presentation page independently of the model context.
     * @param sessionId The session to observe.
     * @param beforeId Exclusive stable message cursor.
     * @returns The requested page and current execution status.
     */
    async transcript(sessionId: string, beforeId?: string): Promise<TranscriptPage> {
        const result = await this.send({
            id: randomUUID(),
            type: 'transcript',
            sessionId,
            ...(beforeId ? { beforeId } : {}),
        });
        if (!result.transcript) throw new Error('Missing transcript page.');
        return result.transcript;
    }

    /** Store immutable artifact bytes in the business database.
     * @param artifact Content-addressed bytes and metadata.
     * @param artifact.id
     * @param artifact.name
     * @param artifact.mediaType
     * @param artifact.data
     */
    async putArtifact(artifact: {
        id: string;
        name: string;
        mediaType: string;
        data: string;
    }): Promise<void> {
        await this.send({ id: randomUUID(), type: 'artifact.put', artifact });
    }

    /** Resolve immutable artifact bytes for a model request.
     * @param artifactId The artifact identity.
     * @returns Original bytes and metadata.
     */
    async getArtifact(artifactId: string) {
        const result = await this.send({ id: randomUUID(), type: 'artifact.get', artifactId });
        if (!result.artifact) throw new Error('Artifact not found.');
        return result.artifact;
    }

    /** Stop admitting requests, drain the worker's queue, and close SQLite. */
    async close(): Promise<void> {
        if (this.closing) {
            await this.exited;
            return;
        }
        const closing = this.send({ type: 'close', id: randomUUID() });
        this.closing = true;
        await closing;
        await this.exited;
    }

    /**
     * Reject all outstanding calls if the worker becomes unavailable.
     * @param error The failure delivered to outstanding callers.
     */
    private fail(error: Error): void {
        this.failure = error;
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
    }

    /**
     * Keep admission bounded and validate both sides of the IPC contract.
     * @param request The validated request for this operation.
     * @returns The matching worker response records.
     */
    private send(request: WorkerRequest): Promise<{
        records: AgentRecord[];
        locale?: 'en' | 'zh-CN';
        transcript?: TranscriptPage;
        artifact?: { id: string; name: string; mediaType: string; data: string };
    }> {
        if (this.failure) return Promise.reject(this.failure);
        if (this.closing) return Promise.reject(new Error('Database is closing.'));
        if (this.pending.size >= 256 && request.type !== 'close')
            return Promise.reject(new Error('Database queue is full.'));
        const validated = requestSchema.parse(request);
        return new Promise((resolve, reject) => {
            this.pending.set(request.id, { resolve, reject });
            try {
                this.worker.postMessage(validated);
            } catch (error) {
                this.pending.delete(request.id);
                reject(error);
            }
        });
    }
}
