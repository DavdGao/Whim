import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';

import { StoreError } from './commands.js';
import { requestSchema, responseSchema } from './protocol.js';

import type { WorkerRequest } from './protocol.js';
import type { AgentRecord, AgentStore, Command } from './records.js';

/** Own the database worker; no synchronous SQLite call runs on the caller's thread. */
export class SqliteStore implements AgentStore {
    private readonly worker: Worker;
    private readonly pending = new Map<
        string,
        { resolve: (records: AgentRecord[]) => void; reject: (error: Error) => void }
    >();
    private closing = false;
    private failure: Error | null = null;
    private readonly ready: Promise<void>;
    private readonly exited: Promise<void>;

    /**
     * Start the worker; use open() to await initialization and migration errors.
     * @param path The SQLite database path.
     */
    private constructor(path: string) {
        this.worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: { path } });
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
                else pending?.resolve(response.records);
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
     * @returns The initialized store.
     */
    static async open(path: string): Promise<SqliteStore> {
        const store = new SqliteStore(path);
        await store.ready;
        return store;
    }

    /**
     * Validate a command and commit its complete batch or reject without any append.
     * @param command The requested journal transition.
     * @returns The original receipt records on an idempotent retry.
     */
    async execute(command: Command): Promise<AgentRecord[]> {
        return this.send({ type: 'execute', id: randomUUID(), command });
    }

    /**
     * Read the immutable journal in session sequence order.
     * @param sessionId The target session identity.
     * @returns The complete ordered journal.
     */
    async read(sessionId: string): Promise<AgentRecord[]> {
        return this.send({ type: 'read', id: randomUUID(), sessionId });
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
    private send(request: WorkerRequest): Promise<AgentRecord[]> {
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
