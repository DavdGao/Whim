import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { Agent, rendererVersion } from '@whimkit/agent';
import {
    ApplicationError,
    Catalog,
    CredentialService,
    CredentialValidationError,
    describeError,
    ModelService,
    PluginHost,
    Store,
    StoreError,
} from '@whimkit/core';
import { z } from 'zod';

import {
    chatSlotSchema,
    localeSchema,
    methodSchemas,
    requestEnvelopeSchema,
} from '../shared/ipc.js';

import type {
    AppState,
    BackendEvent,
    ChatSlot,
    IpcError,
    Method,
    Results,
    SessionSnapshot,
} from '../shared/ipc.js';
import type { AgentEvent } from '@whimkit/agent';
import type { ChatCard, FrozenChatCard, SecretCipher } from '@whimkit/core';
import type { MessagePortMain } from 'electron';

const parentPort = process.parentPort;
const maxConcurrentRuns = 4;
const systemPrompt = 'You are Whim, a helpful assistant. Answer clearly and concisely.';

/** Asks Main to encrypt and decrypt with Electron safeStorage, which is Main-only. */
class MainCipher implements SecretCipher {
    #next = 0;
    readonly #pending = new Map<
        number,
        { resolve: (value: unknown) => void; reject: (error: Error) => void }
    >();

    /**
     * Route a cipher reply from Main.
     * @param message The reply.
     * @param message.id
     * @param message.ok
     * @param message.value
     * @param message.error
     */
    receive(message: { id: number; ok: boolean; value?: unknown; error?: string }): void {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        if (message.ok) pending.resolve(message.value);
        else pending.reject(new Error(message.error ?? 'Secret encryption failed.'));
    }

    /**
     * Send one cipher request.
     * @param op The operation.
     * @param data Its input.
     * @returns The raw result.
     */
    #call(op: 'encrypt' | 'decrypt', data: string | Uint8Array): Promise<unknown> {
        const id = this.#next++;
        return new Promise((resolve, reject) => {
            this.#pending.set(id, { resolve, reject });
            parentPort.postMessage({ type: 'cipher', id, op, data });
        });
    }

    /**
     * Encrypt a secret.
     * @param plaintext The secret.
     * @returns Ciphertext.
     */
    async encrypt(plaintext: string): Promise<Uint8Array<ArrayBuffer>> {
        return new Uint8Array(
            z.instanceof(Uint8Array).parse(await this.#call('encrypt', plaintext))
        );
    }

    /**
     * Decrypt a secret.
     * @param ciphertext The ciphertext.
     * @returns The secret.
     */
    async decrypt(ciphertext: Uint8Array<ArrayBuffer>): Promise<string> {
        return z.string().parse(await this.#call('decrypt', ciphertext));
    }
}

/**
 * Freeze the card fields a session depends on.
 * @param card The live card.
 * @returns The frozen copy.
 */
function freeze(card: ChatCard): FrozenChatCard {
    const { $schema: _schema, ...rest } = card;
    return structuredClone(rest);
}

/**
 * Convert any error into the IPC error shape.
 * @param error The thrown value.
 * @returns A serializable error.
 */
function toIpcError(error: unknown): IpcError {
    if (error instanceof z.ZodError)
        return {
            code: 'invalid',
            message: 'Invalid request.',
            issues: error.issues.map(issue => ({
                path: issue.path.join('.'),
                message: issue.message,
            })),
        };
    if (error instanceof CredentialValidationError)
        return { code: 'invalid', message: error.message, issues: error.issues };
    if (error instanceof ApplicationError)
        return { code: 'unavailable', message: error.message, failure: error.failure };
    if (error instanceof StoreError)
        return {
            code:
                error.code === 'conflict'
                    ? 'conflict'
                    : error.code === 'not-found'
                      ? 'not-found'
                      : 'internal',
            message: error.message,
        };
    return { code: 'internal', message: describeError(error) };
}

/** Owns Core services, the agent, run scheduling, and the Renderer connection. */
class Backend {
    #renderer: MessagePortMain | undefined;
    readonly #runs = new Map<string, { controller: AbortController; done: Promise<void> }>();
    readonly #queue: { sessionId: string; trigger: 'user' | 'continue' | 'restart' }[] = [];
    #accepting = true;
    readonly agent: Agent;

    /**
     * Wire services together.
     * @param store Persistence.
     * @param host Plugins.
     * @param catalog Model cards.
     * @param credentials Credentials.
     * @param models Adapter binding.
     */
    constructor(
        readonly store: Store,
        readonly host: PluginHost,
        readonly catalog: Catalog,
        readonly credentials: CredentialService,
        readonly models: ModelService
    ) {
        this.agent = new Agent(store, models);
        store.onCommit(records => {
            const sessionId = records[0]?.sessionId;
            if (sessionId) this.#emit({ type: 'records', sessionId, records });
            if (
                records.some(record =>
                    ['session.created', 'session.updated', 'run.started', 'run.ended'].includes(
                        record.body.type
                    )
                )
            )
                this.#emit({ type: 'state' });
        });
        catalog.onChange(() => this.#emit({ type: 'state' }));
    }

    /**
     * Attach the Renderer's port, replacing a previous window's.
     * @param port The new port.
     */
    attach(port: MessagePortMain): void {
        this.#renderer?.close();
        this.#renderer = port;
        port.on('message', event => void this.#handle(port, event.data));
        port.start();
    }

    /**
     * Publish an event to the Renderer, if connected.
     * @param event The event.
     */
    #emit(event: BackendEvent): void {
        this.#renderer?.postMessage({ kind: 'event', event });
    }

    /**
     * Answer one Renderer request.
     * @param port The reply port.
     * @param input The raw envelope.
     */
    async #handle(port: MessagePortMain, input: unknown): Promise<void> {
        const envelope = requestEnvelopeSchema.safeParse(input);
        if (!envelope.success) return;
        const { id, method } = envelope.data;
        try {
            if (!(method in methodSchemas)) throw new Error(`Unknown method ${method}.`);
            const value = await this.#dispatch(method as Method, envelope.data.params);
            port.postMessage({ kind: 'response', id, ok: true, value });
        } catch (error) {
            port.postMessage({ kind: 'response', id, ok: false, error: toIpcError(error) });
        }
    }

    /**
     * Validate parameters and run a method.
     * @param method The method name.
     * @param raw Untrusted parameters.
     * @returns The method's result.
     */
    async #dispatch(method: Method, raw: unknown): Promise<Results[Method]> {
        switch (method) {
            case 'app.state':
                methodSchemas[method].parse(raw);
                return this.state();
            case 'settings.locale':
                await this.store.setSetting('locale', methodSchemas[method].parse(raw).locale);
                this.#emit({ type: 'state' });
                return null;
            case 'settings.resumeAfterRestart':
                await this.store.setSetting(
                    'agent.resumeAfterRestart',
                    methodSchemas[method].parse(raw).enabled
                );
                this.#emit({ type: 'state' });
                return null;
            case 'settings.chatSlot':
                await this.store.setSetting('slot.chat', methodSchemas[method].parse(raw).slot);
                this.#emit({ type: 'state' });
                return null;
            case 'credentials.save': {
                const id = await this.credentials.save(methodSchemas[method].parse(raw));
                this.#emit({ type: 'state' });
                return { id };
            }
            case 'credentials.remove':
                await this.credentials.remove(methodSchemas[method].parse(raw).id);
                this.#emit({ type: 'state' });
                return null;
            case 'catalog.reload':
                methodSchemas[method].parse(raw);
                await this.catalog.reload();
                return null;
            case 'plugins.setEnabled': {
                const params = methodSchemas[method].parse(raw);
                await this.host.setEnabled(params.id, params.enabled);
                this.#emit({ type: 'state' });
                return null;
            }
            case 'session.get':
                return this.snapshot(methodSchemas[method].parse(raw).sessionId);
            case 'session.create':
                return {
                    sessionId: await this.createSession(methodSchemas[method].parse(raw).slot),
                };
            case 'session.send': {
                const params = methodSchemas[method].parse(raw);
                return { deliveryId: await this.send(params.sessionId, params.text) };
            }
            case 'session.stop':
                await this.stop(methodSchemas[method].parse(raw).sessionId, 'user');
                return null;
            case 'session.continue':
                this.schedule(methodSchemas[method].parse(raw).sessionId, 'continue');
                return null;
            case 'session.withdraw': {
                const params = methodSchemas[method].parse(raw);
                await this.store.execute({
                    type: 'withdraw',
                    operationId: randomUUID(),
                    ...params,
                });
                return null;
            }
            case 'session.setThinking': {
                const params = methodSchemas[method].parse(raw);
                await this.store.execute({ type: 'update', operationId: randomUUID(), ...params });
                return null;
            }
            case 'session.rename': {
                const params = methodSchemas[method].parse(raw);
                await this.store.execute({ type: 'update', operationId: randomUUID(), ...params });
                return null;
            }
            case 'session.switchModel': {
                const params = methodSchemas[method].parse(raw);
                await this.switchModel(params.sessionId, params.cardId, params.credentialId);
                return null;
            }
        }
    }

    /**
     * Collect everything the shell renders.
     * @returns The application state.
     */
    async state(): Promise<AppState> {
        const locale = localeSchema.safeParse(await this.store.getSetting('locale'));
        const slot = chatSlotSchema.safeParse(await this.store.getSetting('slot.chat'));
        return {
            locale: locale.success ? locale.data : 'en',
            notices: this.store.movedAside
                ? [{ kind: 'database-moved', path: this.store.movedAside }]
                : [],
            resumeAfterRestart: (await this.store.getSetting('agent.resumeAfterRestart')) === true,
            ...(slot.success ? { chatSlot: slot.data } : {}),
            userCardsDir: this.catalog.userDir,
            plugins: this.host.statuses().map(status => ({
                id: status.id,
                version: status.version,
                source: status.source,
                installedAt: status.installedAt,
                enabled: status.enabled,
                availability: status.availability,
                ...(status.error ? { error: status.error } : {}),
                locales: status.locales,
                ...(status.icon ? { icon: status.icon } : {}),
                icons: status.icons,
            })),
            credentialTypes: [...this.host.credentialTypes.values()].map(entry => ({
                id: entry.type.id,
                pluginId: entry.pluginId,
                schema: entry.type.schema,
            })),
            adapters: [...this.host.chatAdapters.values()].map(entry => ({
                id: entry.adapter.id,
                pluginId: entry.pluginId,
                credentialTypes: entry.adapter.credentialTypes,
            })),
            catalog: this.catalog.entries(),
            credentials: await this.credentials.list(),
            sessions: (await this.store.sessions()).map(session => ({
                sessionId: session.sessionId,
                title: session.title,
                cardId: session.cardId,
                createdAt: session.createdAt,
                updatedAt: session.updatedAt,
                running: session.running,
            })),
        };
    }

    /**
     * A copyable session view.
     * @param sessionId The session.
     * @returns The snapshot.
     */
    async snapshot(sessionId: string): Promise<SessionSnapshot> {
        const { inbox, ...view } = await this.store.view(sessionId);
        return { ...view, pending: [...inbox.values()] };
    }

    /**
     * Resolve a selectable card or fail with a user-facing reason.
     * @param cardId The card.
     * @param credentialId The credential to use with it.
     * @returns The card.
     */
    async #checkBinding(cardId: string, credentialId: string): Promise<ChatCard> {
        const card = this.catalog.card(cardId);
        if (!card) throw new Error('The selected model is not available.');
        const credential = (await this.credentials.list()).find(item => item.id === credentialId);
        if (!credential) throw new Error('The selected credential does not exist.');
        if (!this.models.accepts(card.adapter, credential.typeId))
            throw new Error('The selected credential does not work with this model.');
        return card;
    }

    /**
     * Create a session from a chat slot.
     * @param slot Credential, card, and thinking level.
     * @returns The session id.
     */
    async createSession(slot: ChatSlot): Promise<string> {
        const card = await this.#checkBinding(slot.cardId, slot.credentialId);
        const sessionId = randomUUID();
        await this.store.execute({
            type: 'create',
            sessionId,
            operationId: randomUUID(),
            title: '',
            credentialId: slot.credentialId,
            ...(slot.thinking ? { thinking: slot.thinking } : {}),
            epoch: {
                epochId: randomUUID(),
                system: systemPrompt,
                card: freeze(card),
                renderer: rendererVersion,
            },
        });
        await this.store.setSetting('slot.chat', slot);
        return sessionId;
    }

    /**
     * Switch a session's model between runs.
     * @param sessionId The session.
     * @param cardId The new card.
     * @param credentialId The credential to use.
     */
    async switchModel(sessionId: string, cardId: string, credentialId: string): Promise<void> {
        const card = await this.#checkBinding(cardId, credentialId);
        const view = await this.store.view(sessionId);
        if (view.run)
            throw new StoreError('conflict', 'The model cannot change while the agent is running.');
        await this.store.execute({
            type: 'switch-model',
            sessionId,
            operationId: randomUUID(),
            epoch: {
                epochId: randomUUID(),
                system: view.epoch.system,
                card: freeze(card),
                renderer: rendererVersion,
            },
        });
        if (credentialId !== view.credentialId)
            await this.store.execute({
                type: 'update',
                sessionId,
                operationId: randomUUID(),
                credentialId,
            });
    }

    /**
     * Admit and accept a user message, then make sure a run picks it up.
     * @param sessionId The session.
     * @param text The message text.
     * @returns The delivery id.
     */
    async send(sessionId: string, text: string): Promise<string> {
        if (!this.#accepting) throw new Error('Whim is shutting down.');
        const view = await this.store.view(sessionId);
        const session = await this.models.open(view.epoch.card, view.credentialId);
        const estimate = Math.ceil(new TextEncoder().encode(text).length / 3);
        if (estimate > session.inputBudget())
            throw new ApplicationError({
                category: 'context-limit',
                retry: { kind: 'after-change', change: 'input' },
                outcome: 'rejected',
                detail: {
                    provider: 'whim',
                    message: `This message is too long for the model (about ${estimate} tokens).`,
                },
            });
        const deliveryId = randomUUID();
        await this.store.execute({
            type: 'send',
            sessionId,
            operationId: randomUUID(),
            deliveryId,
            placement: 'next-step',
            item: {
                type: 'message',
                id: randomUUID(),
                role: 'user',
                blocks: [{ type: 'text', text }],
            },
        });
        if (!view.title)
            await this.store.execute({
                type: 'update',
                sessionId,
                operationId: randomUUID(),
                title: text.replace(/\s+/g, ' ').slice(0, 60),
            });
        this.schedule(sessionId, 'user');
        return deliveryId;
    }

    /**
     * Start a run now, or queue it when the concurrency bound is reached.
     * @param sessionId The session.
     * @param trigger Why the run starts.
     */
    schedule(sessionId: string, trigger: 'user' | 'continue' | 'restart'): void {
        if (!this.#accepting || this.#runs.has(sessionId)) return;
        if (this.#runs.size >= maxConcurrentRuns) {
            if (!this.#queue.some(item => item.sessionId === sessionId))
                this.#queue.push({ sessionId, trigger });
            return;
        }
        const controller = new AbortController();
        const done = this.#pump(sessionId, trigger, controller.signal).finally(() => {
            this.#runs.delete(sessionId);
            void this.#afterRun(sessionId);
        });
        this.#runs.set(sessionId, { controller, done });
    }

    /**
     * Consume the agent generator, forwarding transient events.
     * @param sessionId The session.
     * @param trigger Why the run started.
     * @param signal Interruption.
     */
    async #pump(
        sessionId: string,
        trigger: 'user' | 'continue' | 'restart',
        signal: AbortSignal
    ): Promise<void> {
        try {
            for await (const event of this.agent.run(sessionId, trigger, signal))
                this.#forward(event);
        } catch (error) {
            console.error(`Run for ${sessionId} failed:`, describeError(error));
        }
    }

    /**
     * Forward one transient agent event.
     * @param event The event.
     */
    #forward(event: AgentEvent): void {
        this.#emit(event);
    }

    /**
     * Start queued work and pick up messages that arrived as the run ended.
     * @param sessionId The session whose run ended.
     */
    async #afterRun(sessionId: string): Promise<void> {
        const next = this.#queue.shift();
        if (next) this.schedule(next.sessionId, next.trigger);
        try {
            const view = await this.store.view(sessionId);
            const waiting = [...view.inbox.values()].some(
                pending => pending.item.type === 'message'
            );
            if (waiting && view.lastRun?.result.outcome === 'completed')
                this.schedule(sessionId, 'user');
        } catch (error) {
            console.error(`Cannot inspect ${sessionId} after its run:`, describeError(error));
        }
    }

    /**
     * Interrupt a session's run: commit the fence first, then cancel.
     * @param sessionId The session.
     * @param reason Why.
     */
    async stop(sessionId: string, reason: 'user' | 'shutdown'): Promise<void> {
        this.#queue.splice(
            0,
            this.#queue.length,
            ...this.#queue.filter(item => item.sessionId !== sessionId)
        );
        const view = await this.store.view(sessionId);
        if (view.run)
            await this.store.execute({
                type: 'interrupt',
                sessionId,
                operationId: randomUUID(),
                runId: view.run.runId,
                reason,
                observedAt: new Date().toISOString(),
            });
        const run = this.#runs.get(sessionId);
        run?.controller.abort();
        await run?.done;
    }

    /** Recover sessions left running by a crash or cut off by shutdown. */
    async recover(): Promise<void> {
        const resume = (await this.store.getSetting('agent.resumeAfterRestart')) === true;
        for (const session of await this.store.recoverySessions()) {
            try {
                const view = await this.store.view(session.sessionId);
                await this.store.execute({
                    type: 'recover',
                    sessionId: session.sessionId,
                    operationId: randomUUID(),
                    reason: view.run?.interrupt === 'shutdown' ? 'shutdown' : 'crash',
                    observedAt: new Date().toISOString(),
                });
                if (resume) this.schedule(session.sessionId, 'restart');
            } catch (error) {
                console.error(`Cannot recover ${session.sessionId}:`, describeError(error));
            }
        }
    }

    /** Stop admission, interrupt runs, then release plugins and the database. */
    async shutdown(): Promise<void> {
        this.#accepting = false;
        this.#queue.length = 0;
        const stopping = [...this.#runs.keys()].map(sessionId =>
            this.stop(sessionId, 'shutdown').catch(error =>
                console.error('Stop failed:', describeError(error))
            )
        );
        await Promise.race([
            Promise.all(stopping),
            new Promise(resolve => setTimeout(resolve, 5000)),
        ]);
        this.catalog.stop();
        await this.host.stop();
        await this.store.close();
    }
}

/**
 * Locate bundled plugin package directories.
 * @returns Package roots.
 */
function bundledPlugins(): { dir: string; source: 'bundled' }[] {
    const require = createRequire(import.meta.url);
    return ['@whimkit/plugin-dashscope'].map(name => ({
        dir: dirname(require.resolve(`${name}/package.json`)),
        source: 'bundled' as const,
    }));
}

const initSchema = z.strictObject({ type: z.literal('init'), userData: z.string().min(1) });
const cipherReplySchema = z.object({
    type: z.literal('cipher'),
    id: z.number(),
    ok: z.boolean(),
    value: z.unknown().optional(),
    error: z.string().optional(),
});

let backend: Backend | undefined;
const cipher = new MainCipher();
const pendingPorts: MessagePortMain[] = [];

parentPort.on('message', event => {
    const data: unknown = event.data;
    const reply = cipherReplySchema.safeParse(data);
    if (reply.success) return cipher.receive(reply.data);
    if (z.object({ type: z.literal('renderer') }).safeParse(data).success && event.ports[0]) {
        if (backend) backend.attach(event.ports[0]);
        else pendingPorts.push(event.ports[0]);
        return;
    }
    if (z.object({ type: z.literal('shutdown') }).safeParse(data).success) {
        void (backend?.shutdown() ?? Promise.resolve())
            .catch(error => console.error('Shutdown failed:', describeError(error)))
            .finally(() => {
                parentPort.postMessage({ type: 'stopped' });
                process.exit(0);
            });
        return;
    }
    const init = initSchema.safeParse(data);
    if (init.success) void start(init.data.userData);
});

/**
 * Open services and report readiness to Main.
 * @param userData The application data directory.
 */
async function start(userData: string): Promise<void> {
    try {
        const store = await Store.open(join(userData, 'whim.sqlite'));
        const host = new PluginHost(store, bundledPlugins());
        await host.start();
        const catalog = new Catalog(host, join(userData, 'models'));
        await catalog.start();
        const credentials = new CredentialService(store, host, cipher);
        backend = new Backend(
            store,
            host,
            catalog,
            credentials,
            new ModelService(host, credentials)
        );
        await backend.recover();
        for (const port of pendingPorts.splice(0)) backend.attach(port);
        parentPort.postMessage({ type: 'ready' });
    } catch (error) {
        parentPort.postMessage({ type: 'fatal', message: describeError(error) });
    }
}
