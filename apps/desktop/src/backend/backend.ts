import { randomUUID } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

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
    ToolRuntime,
} from '@whimkit/core';
import { baseTools } from '@whimkit/tools';
import { z } from 'zod';

import {
    agentProfileSchema,
    chatSlotSchema,
    localeSchema,
    methodSchemas,
    requestEnvelopeSchema,
} from '../shared/ipc.js';

import { gitStatus } from './git.js';

import type {
    AgentProfile,
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
const defaultProfile: AgentProfile = {
    name: 'Whim',
    systemPrompt: 'You are {name}, a helpful assistant. Answer clearly and concisely.',
};

/**
 * The system prompt of a new epoch: the profile's instructions plus the environment as
 * observed now. Frozen with the epoch; it changes only at compaction or a model switch.
 * @param profile The agent profile; `{name}` in its prompt becomes the agent's name.
 * @param workspace The session's workspace.
 * @param tools Whether any tools are offered.
 * @returns The prompt.
 */
function systemPrompt(
    profile: AgentProfile,
    workspace: string | undefined,
    tools: boolean
): string {
    const now = new Date();
    const lines = [
        profile.systemPrompt.replaceAll('{name}', profile.name),
        ...(profile.userName ? ['', `Address the user as ${profile.userName}.`] : []),
        '',
        `<environment observed-at="${now.toISOString()}">`,
        `Date: ${now.toISOString().slice(0, 10)}`,
        `Platform: ${process.platform}`,
        workspace
            ? `Workspace: ${workspace} (relative paths resolve here)`
            : 'Workspace: none; file and shell tools are not available in this chat.',
        '</environment>',
    ];
    if (tools)
        lines.push(
            '',
            'Use tools when they help. Read files before editing them. Calls that change files, run commands, or reach the network may ask the user first; if a call is denied, do not retry it unchanged.'
        );
    return lines.join('\n');
}

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

type RunTrigger = 'user' | 'continue' | 'restart' | 'job';

/** Owns Core services, the agent, run scheduling, and the Renderer connection. */
class Backend {
    #renderer: MessagePortMain | undefined;
    readonly #runs = new Map<string, { controller: AbortController; done: Promise<void> }>();
    readonly #queue: { sessionId: string; trigger: RunTrigger }[] = [];
    #accepting = true;
    readonly agent: Agent;
    readonly tools: ToolRuntime;
    readonly #baseTools: ReturnType<typeof baseTools>;

    /**
     * Wire services together.
     * @param store Persistence.
     * @param host Plugins.
     * @param catalog Model cards.
     * @param credentials Credentials.
     * @param models Adapter binding.
     * @param artifactsDir Directory for offloaded tool output.
     * @param version Application version.
     * @param defaultWorkspace The folder a chat works in when the user picks none.
     */
    constructor(
        readonly store: Store,
        readonly host: PluginHost,
        readonly catalog: Catalog,
        readonly credentials: CredentialService,
        readonly models: ModelService,
        artifactsDir: string,
        version: string,
        readonly defaultWorkspace: string
    ) {
        this.#baseTools = baseTools(version);
        // A finished background job wakes an idle session so the agent can react to it.
        this.tools = new ToolRuntime(
            store,
            host,
            models,
            credentials,
            this.#baseTools,
            artifactsDir,
            sessionId => this.schedule(sessionId, 'job')
        );
        this.agent = new Agent(store, models, this.tools);
        store.onCommit(records => {
            const sessionId = records[0]?.sessionId;
            if (sessionId) this.#emit({ type: 'records', sessionId, records });
            if (
                records.some(record =>
                    [
                        'session.created',
                        'session.updated',
                        'run.started',
                        'run.ended',
                        'permission.requested',
                        'permission.decided',
                    ].includes(record.body.type)
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
            case 'settings.agent': {
                const { profile } = methodSchemas[method].parse(raw);
                await this.store.setSetting('agent.profile', profile);
                this.#emit({ type: 'state' });
                return null;
            }
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
            case 'session.create': {
                const params = methodSchemas[method].parse(raw);
                return { sessionId: await this.createSession(params.slot, params.workspace) };
            }
            case 'session.decide': {
                const params = methodSchemas[method].parse(raw);
                await this.tools.decide(
                    params.sessionId,
                    params.callId,
                    params.decision,
                    params.scope
                );
                return null;
            }
            case 'session.send': {
                const params = methodSchemas[method].parse(raw);
                return { deliveryId: await this.send(params.sessionId, params.text) };
            }
            case 'session.stop':
                await this.stop(methodSchemas[method].parse(raw).sessionId, 'user');
                return null;
            case 'session.pin': {
                const params = methodSchemas[method].parse(raw);
                const pinned = (await this.#pinned()).filter(id => id !== params.sessionId);
                await this.store.setSetting(
                    'sessions.pinned',
                    params.pinned ? [params.sessionId, ...pinned] : pinned
                );
                this.#emit({ type: 'state' });
                return null;
            }
            case 'session.delete': {
                const { sessionId } = methodSchemas[method].parse(raw);
                await this.store.deleteSession(sessionId);
                await this.store.setSetting(
                    'sessions.pinned',
                    (await this.#pinned()).filter(id => id !== sessionId)
                );
                this.#emit({ type: 'state' });
                return null;
            }
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
            case 'session.setWorkspace': {
                const params = methodSchemas[method].parse(raw);
                await this.setWorkspace(params.sessionId, params.workspace);
                return null;
            }
            case 'workspace.git': {
                const params = methodSchemas[method].parse(raw);
                if (!isAbsolute(params.path)) return null;
                return gitStatus(params.path, AbortSignal.timeout(8000));
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
        const savedProfile = agentProfileSchema.safeParse(
            await this.store.getSetting('agent.profile')
        ).success;
        const profile = await this.#profile();
        const pinned = await this.#pinned();
        return {
            locale: locale.success ? locale.data : 'en',
            notices: this.store.movedAside
                ? [{ kind: 'database-moved', path: this.store.movedAside }]
                : [],
            resumeAfterRestart: (await this.store.getSetting('agent.resumeAfterRestart')) === true,
            ...(slot.success ? { chatSlot: slot.data } : {}),
            userCardsDir: this.catalog.userDir,
            defaultWorkspace: this.defaultWorkspace,
            baseTools: this.#baseTools.map(tool => tool.name),
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
                category: status.category,
                adapters: [...this.host.chatAdapters.values()].filter(
                    entry => entry.pluginId === status.id
                ).length,
                credentialTypes: [...this.host.credentialTypes.values()].filter(
                    entry => entry.pluginId === status.id
                ).length,
                tools: [...this.host.tools.values()]
                    .filter(entry => entry.pluginId === status.id)
                    .map(entry => entry.tool.name),
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
            agent: { ...profile, isDefault: !savedProfile },
            sessions: (await this.store.sessions()).map(session => ({
                sessionId: session.sessionId,
                title: session.title,
                cardId: session.cardId,
                createdAt: session.createdAt,
                updatedAt: session.updatedAt,
                running: session.running,
                pinned: pinned.includes(session.sessionId),
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
     * The saved agent profile, or the default.
     * @returns The profile.
     */
    async #profile(): Promise<AgentProfile> {
        const saved = agentProfileSchema.safeParse(await this.store.getSetting('agent.profile'));
        return saved.success ? saved.data : defaultProfile;
    }

    /**
     * Pinned session ids, most recently pinned first.
     * @returns The ids.
     */
    async #pinned(): Promise<string[]> {
        const saved = z.array(z.string()).safeParse(await this.store.getSetting('sessions.pinned'));
        return saved.success ? saved.data : [];
    }

    /**
     * The tool set and prompt of a new epoch.
     * @param card The card the epoch uses.
     * @param workspace The session's workspace.
     * @returns Epoch fields.
     */
    async #epoch(card: ChatCard, workspace: string | undefined) {
        // Provider tools the adapter runs as separate calls keep the local tool's declaration, so
        // the tool list depends only on the card and never on per-request options like thinking.
        const separate = this.host.chatAdapters.get(card.adapter)?.adapter.separateTools ?? [];
        const nativeTools = card.nativeTools.filter(tool => !separate.includes(tool));
        const providerTools = card.nativeTools.filter(tool => separate.includes(tool));
        const credentialTypes = new Set(
            (await this.credentials.list())
                .filter(credential => credential.available)
                .map(credential => credential.typeId)
        );
        const tools = this.tools.declarations(workspace, nativeTools, credentialTypes);
        const profile = await this.#profile();
        return {
            epochId: randomUUID(),
            system: systemPrompt(profile, workspace, tools.length + nativeTools.length > 0),
            card: freeze(card),
            renderer: rendererVersion,
            tools,
            nativeTools,
            providerTools,
        };
    }

    /**
     * Move a chat to another folder between runs; the model is told through a notice.
     * @param sessionId The session.
     * @param workspace An absolute, existing directory.
     */
    async setWorkspace(sessionId: string, workspace: string): Promise<void> {
        if (workspace === this.defaultWorkspace) await mkdir(workspace, { recursive: true });
        const info = isAbsolute(workspace) ? await stat(workspace).catch(() => null) : null;
        if (!info?.isDirectory())
            throw new StoreError('invalid', 'The workspace folder does not exist.');
        await this.store.execute({
            type: 'set-workspace',
            sessionId,
            operationId: randomUUID(),
            workspace,
            deliveryId: randomUUID(),
            noticeId: randomUUID(),
            observedAt: new Date().toISOString(),
        });
    }

    /**
     * Create a session from a chat slot.
     * @param slot Credential, card, and thinking level.
     * @param chosen Absolute directory the session works in; the default folder when absent.
     * @returns The session id.
     */
    async createSession(slot: ChatSlot, chosen?: string): Promise<string> {
        const card = await this.#checkBinding(slot.cardId, slot.credentialId);
        if (chosen !== undefined) {
            const info = isAbsolute(chosen) ? await stat(chosen).catch(() => null) : null;
            if (!info?.isDirectory())
                throw new StoreError('invalid', 'The workspace folder does not exist.');
        } else await mkdir(this.defaultWorkspace, { recursive: true });
        const workspace = chosen ?? this.defaultWorkspace;
        const sessionId = randomUUID();
        await this.store.execute({
            type: 'create',
            sessionId,
            operationId: randomUUID(),
            title: '',
            credentialId: slot.credentialId,
            ...(slot.thinking ? { thinking: slot.thinking } : {}),
            workspace,
            epoch: await this.#epoch(card, workspace),
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
            // The prefix changes with the model anyway, so the tool set and environment refresh.
            epoch: await this.#epoch(card, view.workspace),
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
    schedule(sessionId: string, trigger: RunTrigger): void {
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
    async #pump(sessionId: string, trigger: RunTrigger, signal: AbortSignal): Promise<void> {
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
        await this.tools.shutdown();
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
    return ['@whimkit/plugin-dashscope', '@whimkit/plugin-tavily'].map(name => ({
        dir: dirname(require.resolve(`${name}/package.json`)),
        source: 'bundled' as const,
    }));
}

const initSchema = z.strictObject({
    type: z.literal('init'),
    userData: z.string().min(1),
    version: z.string().min(1),
});
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
    if (init.success) void start(init.data.userData, init.data.version);
});

/**
 * Open services and report readiness to Main.
 * @param userData The application data directory.
 * @param version Application version.
 */
async function start(userData: string, version: string): Promise<void> {
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
            new ModelService(host, credentials),
            join(userData, 'artifacts'),
            version,
            join(homedir(), 'Whim')
        );
        await backend.recover();
        for (const port of pendingPorts.splice(0)) backend.attach(port);
        parentPort.postMessage({ type: 'ready' });
    } catch (error) {
        parentPort.postMessage({ type: 'fatal', message: describeError(error) });
    }
}
