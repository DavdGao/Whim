import { rename } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';

import { z } from 'zod';

import { recordSchema } from '../contracts/records.js';

import { StoreError } from './commands.js';
import {
    credentialRowSchema,
    pluginRowSchema,
    scheduleRowSchema,
    sessionSummarySchema,
    sourceRowSchema,
} from './db/protocol.js';

import type { Command } from './commands.js';
import type { AgentRecord } from '../contracts/records.js';
import type { SessionView } from '../contracts/view.js';
import type {
    CredentialRow,
    PluginRow,
    RequestInput,
    ScheduleRow,
    SessionSummary,
    SourceRow,
} from './db/protocol.js';

const responseSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('ready') }),
    z.object({ type: z.literal('foreign') }),
    z.object({ type: z.literal('result'), id: z.number(), value: z.unknown() }),
    z.object({
        type: z.literal('error'),
        id: z.number(),
        code: z.enum(['conflict', 'not-found', 'invalid', 'unreadable', 'internal']),
        message: z.string(),
    }),
]);

type Listener = (records: readonly AgentRecord[]) => void;

/** Asynchronous access to the SQLite database owned by a dedicated worker thread. */
export class Store {
    readonly #worker: Worker;
    readonly #pending = new Map<
        number,
        { resolve: (value: unknown) => void; reject: (error: Error) => void }
    >();
    readonly #listeners = new Set<Listener>();
    #next = 0;
    #failure: Error | null = null;

    /**
     * Use {@link Store.open}.
     * @param worker The started worker.
     */
    private constructor(worker: Worker) {
        this.#worker = worker;
        worker.on('message', message => this.#receive(message));
        worker.on('error', error =>
            this.#fail(new StoreError('internal', 'Database worker failed.', { cause: error }))
        );
        worker.on('exit', code => {
            if (code !== 0)
                this.#fail(new StoreError('internal', `Database worker exited with ${code}.`));
            else this.#fail(new StoreError('internal', 'Database is closed.'));
        });
    }

    /** Where a file that was not a Whim database was moved, when that happened on open. */
    movedAside: string | undefined;

    /**
     * Open the database, running migrations before resolving. A file at `path` that is not a
     * Whim database is renamed, never modified, and a new database is created.
     * @param path Database file path, or `:memory:`.
     * @returns The ready store.
     */
    static async open(path: string): Promise<Store> {
        const first = await Store.#start(path);
        if (first.kind === 'ready') return new Store(first.worker);
        await first.worker.terminate();
        const target = `${path}.foreign-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        for (const suffix of ['', '-wal', '-shm']) {
            try {
                await rename(`${path}${suffix}`, `${target}${suffix}`);
            } catch (error) {
                if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
                    throw error;
            }
        }
        const second = await Store.#start(path);
        if (second.kind !== 'ready')
            throw new StoreError('internal', 'A new database could not be created.');
        const store = new Store(second.worker);
        store.movedAside = target;
        return store;
    }

    /**
     * Start a worker and wait until it is ready or reports a foreign file.
     * @param path Database file path.
     * @returns The worker and its state.
     */
    static async #start(path: string): Promise<{ kind: 'ready' | 'foreign'; worker: Worker }> {
        const worker = new Worker(new URL('./db/worker.js', import.meta.url), {
            workerData: { path },
        });
        const kind = await new Promise<'ready' | 'foreign'>((resolve, reject) => {
            const onMessage = (message: unknown) => {
                const type = responseSchema.safeParse(message).data?.type;
                if (type === 'ready' || type === 'foreign') {
                    cleanup();
                    resolve(type);
                }
            };
            const onError = (error: Error) => {
                cleanup();
                reject(new StoreError('internal', 'Database failed to open.', { cause: error }));
            };
            const cleanup = () => {
                worker.off('message', onMessage);
                worker.off('error', onError);
            };
            worker.on('message', onMessage);
            worker.on('error', onError);
        });
        return { kind, worker };
    }

    /**
     * Route a worker response to its caller.
     * @param message The raw worker message.
     */
    #receive(message: unknown): void {
        const parsed = responseSchema.parse(message);
        if (parsed.type === 'ready' || parsed.type === 'foreign') return;
        const pending = this.#pending.get(parsed.id);
        if (!pending) return;
        this.#pending.delete(parsed.id);
        if (parsed.type === 'result') pending.resolve(parsed.value);
        else pending.reject(new StoreError(parsed.code, parsed.message));
    }

    /**
     * Reject all outstanding requests after the worker stops.
     * @param error The terminal error.
     */
    #fail(error: Error): void {
        this.#failure ??= error;
        for (const pending of this.#pending.values()) pending.reject(error);
        this.#pending.clear();
    }

    /**
     * Send one request to the worker.
     * @param request The request without its id.
     * @returns The raw result value.
     */
    #request(request: RequestInput): Promise<unknown> {
        if (this.#failure) return Promise.reject(this.#failure);
        const id = this.#next++;
        return new Promise((resolve, reject) => {
            this.#pending.set(id, { resolve, reject });
            this.#worker.postMessage({ ...request, id });
        });
    }

    /**
     * Observe records after each commit. Listeners run synchronously after the command resolves.
     * @param listener Receives the committed records of one command.
     * @returns A disposer.
     */
    onCommit(listener: Listener): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    /**
     * Execute a command atomically and idempotently.
     * @param command The command.
     * @returns The produced records.
     */
    async execute(command: Command): Promise<AgentRecord[]> {
        const records = z
            .array(recordSchema)
            .parse(await this.#request({ op: 'execute', command }));
        if (records.length) for (const listener of this.#listeners) listener(records);
        return records;
    }

    /**
     * Read records of a session after a sequence number.
     * @param sessionId The session.
     * @param afterSeq Exclusive lower bound.
     * @returns Records in order.
     */
    async read(sessionId: string, afterSeq = 0): Promise<AgentRecord[]> {
        return z
            .array(recordSchema)
            .parse(await this.#request({ op: 'read', sessionId, afterSeq }));
    }

    /**
     * Fetch the current view of a session.
     * @param sessionId The session.
     * @returns The folded view.
     */
    async view(sessionId: string): Promise<SessionView> {
        return (await this.#request({ op: 'view', sessionId })) as SessionView;
    }

    /**
     * List sessions, most recently updated first.
     * @returns Session summaries.
     */
    async sessions(): Promise<SessionSummary[]> {
        return z.array(sessionSummarySchema).parse(await this.#request({ op: 'sessions' }));
    }

    /**
     * List sessions with an unfinished run or an undelivered restart notice.
     * @returns Session summaries.
     */
    async recoverySessions(): Promise<SessionSummary[]> {
        return z
            .array(sessionSummarySchema)
            .parse(await this.#request({ op: 'recovery-sessions' }));
    }

    /**
     * Permanently delete a session's journal and projection, at the user's request. Refused
     * while it has an active run or background jobs.
     * @param sessionId The session.
     */
    async deleteSession(sessionId: string): Promise<void> {
        await this.#request({ op: 'session.delete', sessionId });
    }

    /**
     * Read a JSON setting.
     * @param key Setting key.
     * @returns The stored value, or undefined.
     */
    async getSetting(key: string): Promise<unknown> {
        return this.#request({ op: 'setting.get', key });
    }

    /**
     * Write a JSON setting.
     * @param key Setting key.
     * @param value JSON-compatible value.
     */
    async setSetting(key: string, value: unknown): Promise<void> {
        await this.#request({ op: 'setting.set', key, value });
    }

    /**
     * List credentials with the names of their stored secrets.
     * @returns Credential rows.
     */
    async credentials(): Promise<{ credential: CredentialRow; secretProperties: string[] }[]> {
        return z
            .array(
                z.object({ credential: credentialRowSchema, secretProperties: z.array(z.string()) })
            )
            .parse(await this.#request({ op: 'credential.list' }));
    }

    /**
     * Insert or update a credential and its encrypted secrets in one transaction.
     * @param credential The non-secret row.
     * @param secrets Encrypted secrets to set.
     * @param removeSecrets Secret properties to delete.
     */
    async putCredential(
        credential: CredentialRow,
        secrets: Record<string, Uint8Array<ArrayBuffer>>,
        removeSecrets: string[]
    ): Promise<void> {
        await this.#request({ op: 'credential.put', credential, secrets, removeSecrets });
    }

    /**
     * Delete a credential and its secrets.
     * @param credentialId The credential.
     */
    async deleteCredential(credentialId: string): Promise<void> {
        await this.#request({ op: 'credential.delete', credentialId });
    }

    /**
     * Read the encrypted secrets of a credential.
     * @param credentialId The credential.
     * @returns Ciphertext by property.
     */
    async secrets(credentialId: string): Promise<Record<string, Uint8Array<ArrayBuffer>>> {
        return z
            .record(z.string(), z.instanceof(Uint8Array))
            .parse(await this.#request({ op: 'secret.get', credentialId }));
    }

    /**
     * List plugin installation records.
     * @returns Plugin rows.
     */
    async plugins(): Promise<PluginRow[]> {
        return z.array(pluginRowSchema).parse(await this.#request({ op: 'plugin.list' }));
    }

    /**
     * Insert or update a plugin installation record.
     * @param plugin The row.
     */
    async putPlugin(plugin: PluginRow): Promise<void> {
        await this.#request({ op: 'plugin.put', plugin });
    }

    /**
     * List schedules, oldest first.
     * @param sessionId Only this session's; all when omitted.
     * @returns The schedules.
     */
    async schedules(sessionId?: string): Promise<ScheduleRow[]> {
        return z.array(scheduleRowSchema).parse(
            await this.#request({
                op: 'schedule.list',
                ...(sessionId === undefined ? {} : { sessionId }),
            })
        );
    }

    /**
     * Insert or replace a schedule.
     * @param schedule The schedule.
     */
    async putSchedule(schedule: ScheduleRow): Promise<void> {
        await this.#request({ op: 'schedule.put', schedule });
    }

    /**
     * Delete a schedule.
     * @param scheduleId The schedule.
     */
    async deleteSchedule(scheduleId: string): Promise<void> {
        await this.#request({ op: 'schedule.delete', scheduleId });
    }

    /**
     * Commit a schedule's fire atomically: the delivery, when given, and its next fire time.
     * @param scheduleId The schedule.
     * @param due The fire time read; nothing happens when the schedule no longer has it.
     * @param next The following fire time, or null when there is none.
     * @param command The delivery to commit; omitted when a missed fire is skipped.
     * @returns Whether the fire was committed.
     */
    async fireSchedule(
        scheduleId: string,
        due: string,
        next: string | null,
        command?: Command
    ): Promise<boolean> {
        const result = z
            .array(recordSchema)
            .nullable()
            .parse(
                await this.#request({
                    op: 'schedule.fire',
                    scheduleId,
                    due,
                    next,
                    ...(command ? { command } : {}),
                })
            );
        if (result?.length) for (const listener of this.#listeners) listener(result);
        return result !== null;
    }

    /**
     * List information sources, oldest first.
     * @returns The sources.
     */
    async sources(): Promise<SourceRow[]> {
        return z.array(sourceRowSchema).parse(await this.#request({ op: 'source.list' }));
    }

    /**
     * Insert a source or rename it.
     * @param source The source.
     */
    async putSource(source: SourceRow): Promise<void> {
        await this.#request({ op: 'source.put', source });
    }

    /**
     * Delete a source together with its session, at the user's request; refused while it runs.
     * @param sourceId The source.
     */
    async deleteSource(sourceId: string): Promise<void> {
        await this.#request({ op: 'source.delete', sourceId });
    }

    /** Close the database after outstanding requests. */
    async close(): Promise<void> {
        if (this.#failure) return;
        await this.#request({ op: 'close' });
        await this.#worker.terminate();
    }
}
