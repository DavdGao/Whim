import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { z } from 'zod';

import { selectableLevels } from '../contracts/card.js';
import { ApplicationError, boundText } from '../contracts/failure.js';
import { knownFiles } from '../contracts/view.js';

import { StoreError } from './commands.js';
import { CompiledSchema } from './json-schema.js';
import { storeMedia } from './media.js';
import { evaluate } from './permissions.js';
import { describeError } from './plugin-host.js';
import { reviewRequest } from './review.js';

import type { Command } from './commands.js';
import type { PluginHost } from './plugin-host.js';
import type { Review, Reviewer, ReviewRequest } from './review.js';
import type { Store } from './store.js';
import type { FrozenChatCard, ThinkingLevel } from '../contracts/card.js';
import type { Failure } from '../contracts/failure.js';
import type { FileVersion, ToolDeclaration, ToolResult } from '../contracts/records.js';
import type { OpenCall, SessionView } from '../contracts/view.js';
import type {
    ChatSession,
    ResolvedCredential,
    ToolContext,
    ToolDefinition,
    ToolOutput,
} from '../plugin/index.js';

/** Opens the session's model binding for tools the adapter runs; Core's ModelService. */
export interface ToolModels {
    open(card: FrozenChatCard, credentialId: string): Promise<ChatSession>;
}

/** Credentials for tools that declare a `credentialType`; Core's CredentialService. */
export interface ToolCredentials {
    list(): Promise<readonly { id: string; typeId: string; available: boolean }[]>;
    resolve(id: string): Promise<ResolvedCredential>;
}

/**
 * The thinking level of a provider-run tool call. Providers may require thinking for their
 * tools, so the chat's level is used when on and the card's default (or highest) otherwise.
 * @param view The session view.
 * @returns The level, or undefined when the card has no adjustable thinking.
 */
function toolThinking(view: SessionView): ThinkingLevel | undefined {
    const levels = selectableLevels(view.epoch.card.thinking);
    const on: readonly ThinkingLevel[] = levels.filter(level => level !== 'off');
    if (view.thinking && on.includes(view.thinking)) return view.thinking;
    const thinking = view.epoch.card.thinking;
    const fallback =
        thinking && typeof thinking === 'object' && 'default' in thinking
            ? on.find(level => level === thinking.default)
            : undefined;
    return fallback ?? on.at(-1);
}

/** Results above this many UTF-8 bytes are offloaded to a file with a preview in context. */
export const maxResultBytes = 32 * 1024;
const previewBytes = 8 * 1024;
const maxParallel = 4;
const maxJobOutputRead = 32 * 1024;
/** How long a cancelled foreground job may take to settle before its result is written. */
const cancelGraceMs = 5000;
/** An automatic review taking longer is left to the user. */
const reviewTimeoutMs = 60_000;

type Decision = { decision: 'allow' | 'deny' } | { decision: 'cancelled' };

interface Job {
    readonly jobId: string;
    readonly sessionId: string;
    readonly callId: string;
    readonly name: string;
    readonly controller: AbortController;
    readonly log: string;
    /** Serializes appends so output stays in order. */
    writes: Promise<void>;
    bytes: number;
    tail: string;
    done: Promise<ToolOutput>;
}

interface Resolved {
    readonly tool: ToolDefinition<unknown>;
    readonly input: unknown;
}

const jobOutputSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['jobId'],
    properties: {
        jobId: { type: 'string', description: 'The job id from a background tool result.' },
        offset: {
            type: 'integer',
            minimum: 0,
            description: 'Byte offset to read from; omit to read from the start.',
        },
    },
} as const;

const jobStopSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['jobId'],
    properties: { jobId: { type: 'string', description: 'The job to cancel.' } },
} as const;

/**
 * Keep the end of a text within a byte budget.
 * @param text The text.
 * @param bytes The budget.
 * @returns The tail.
 */
function tailOf(text: string, bytes: number): string {
    const encoded = Buffer.from(text, 'utf8');
    return encoded.byteLength <= bytes
        ? text
        : encoded
              .subarray(encoded.byteLength - bytes)
              .toString('utf8')
              .replace(/^�+/, '');
}

/**
 * Wait for a promise, a timeout, or an abort, whichever comes first.
 * @param promise The work.
 * @param ms Timeout; undefined waits forever.
 * @param signal Abort.
 * @returns Which happened.
 */
function race<T>(
    promise: Promise<T>,
    ms: number | undefined,
    signal: AbortSignal
): Promise<{ kind: 'done'; value: T } | { kind: 'timeout' } | { kind: 'aborted' }> {
    return new Promise(resolve => {
        let timer: NodeJS.Timeout | undefined;
        const finish = (
            outcome: { kind: 'done'; value: T } | { kind: 'timeout' } | { kind: 'aborted' }
        ) => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            resolve(outcome);
        };
        const onAbort = () => finish({ kind: 'aborted' });
        if (signal.aborted) return finish({ kind: 'aborted' });
        signal.addEventListener('abort', onAbort, { once: true });
        if (ms !== undefined) timer = setTimeout(() => finish({ kind: 'timeout' }), ms);
        void promise.then(value => finish({ kind: 'done', value }));
    });
}

/** Tools that come and go at run time, such as those of MCP servers (design.md §7.7). */
export interface DynamicTools {
    /** The tools available now, for a new epoch. */
    tools(): readonly ToolDefinition<unknown>[];
    /** One tool by name, or undefined when it is not available now. */
    tool(name: string): ToolDefinition<unknown> | undefined;
}

/**
 * Runs tool calls: validation, permissions, scheduling, jobs, background handoff, and
 * truncation. It is the only writer of tool records.
 */
export class ToolRuntime {
    readonly #jobs = new Map<string, Job>();
    readonly #waiters = new Map<string, (decision: Decision) => void>();
    readonly #locks = new Map<string, Promise<void>>();
    readonly #base: readonly ToolDefinition<unknown>[];
    /** Base tools followed by the job tools. */
    readonly #builtins: ToolDefinition<unknown>[];
    readonly #builtinSchemas: Map<string, CompiledSchema>;
    #closing = false;

    /**
     * Create the runtime.
     * @param store Persistence.
     * @param host Plugin-registered tools.
     * @param models Model bindings for tools the session's adapter runs itself.
     * @param credentials Credentials for tools that need one.
     * @param baseTools Built-in tools every agent has; they win over a plugin tool of the same name.
     * @param sessionsDir Directory holding one folder of files per session (offloads, job output,
     * media); a session's folder is removed with the session.
     * @param legacyArtifactsDir Where results were offloaded before per-session folders; still
     * readable without asking.
     * @param onJobEnded Called after a background job's end is committed.
     * @param reviewer The reviewer answering asks first in auto mode, read at each ask; undefined
     * in manual mode. Throwing is a review failure.
     * @param dynamic Tools that come and go at run time, such as those of MCP servers.
     */
    constructor(
        private readonly store: Store,
        private readonly host: PluginHost,
        private readonly models: ToolModels,
        private readonly credentials: ToolCredentials,
        baseTools: readonly ToolDefinition<unknown>[],
        readonly sessionsDir: string,
        private readonly legacyArtifactsDir: string | undefined,
        private readonly onJobEnded: (sessionId: string) => void,
        private readonly reviewer: () => Promise<Reviewer | undefined> = async () => undefined,
        private readonly dynamic: DynamicTools = { tools: () => [], tool: () => undefined }
    ) {
        this.#base = baseTools;
        this.#builtins = [...baseTools, this.#jobOutputTool(), this.#jobStopTool()];
        this.#builtinSchemas = new Map(
            this.#builtins.map(tool => [tool.name, new CompiledSchema(tool.inputSchema)])
        );
    }

    /**
     * The folder of a session's files. Session ids are generated UUIDs; anything else is
     * rejected so an id can never point outside the sessions directory.
     * @param sessionId The session.
     * @returns The absolute folder path.
     */
    sessionDir(sessionId: string): string {
        if (!/^[A-Za-z0-9-]+$/.test(sessionId)) throw new Error(`Invalid session id ${sessionId}.`);
        return join(this.sessionsDir, sessionId);
    }

    /**
     * The tools to freeze into a new epoch.
     * @param workspace The session's workspace.
     * @param nativeTools Standard ids the provider executes inside its chat call. Local tools with
     * these ids are left out; tools the adapter runs as separate calls keep their local declaration.
     * @param credentialTypes Credential types the user has; tools needing another are left out.
     * @param allowed Whether the session may use a tool by name; others are left out.
     * @returns Base tools, then plugin tools in registration order, then the job tools.
     */
    declarations(
        workspace: string | undefined,
        nativeTools: readonly string[],
        credentialTypes: ReadonlySet<string> = new Set(),
        allowed: (name: string) => boolean = () => true
    ): ToolDeclaration[] {
        const plugins = [
            ...[...this.host.tools.values()].map(entry => entry.tool),
            ...this.dynamic.tools(),
        ].filter(tool => !this.#builtins.some(builtin => builtin.name === tool.name));
        const tools = [...this.#base, ...plugins].filter(
            tool =>
                (workspace || !tool.needsWorkspace) &&
                !nativeTools.includes(tool.standard ?? '') &&
                (!tool.credentialType || credentialTypes.has(tool.credentialType)) &&
                allowed(tool.name)
        );
        if (tools.length === 0) return [];
        return [...tools, ...this.#builtins.slice(this.#base.length)].map(tool => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
        }));
    }

    /**
     * Execute the open calls of the current step and commit one result for each. Returns early
     * when the run is interrupted; ending the run closes calls that never started.
     * @param sessionId The session.
     * @param runId The active run.
     * @param signal Run interruption.
     */
    async run(sessionId: string, runId: string, signal: AbortSignal): Promise<void> {
        const view = await this.store.view(sessionId);
        const calls = view.calls.filter(call => call.state === 'pending');
        let index = 0;
        while (index < calls.length && !signal.aborted) {
            const group = [calls[index]];
            if (this.#concurrencySafe(view, calls[index]))
                while (
                    index + group.length < calls.length &&
                    this.#concurrencySafe(view, calls[index + group.length])
                )
                    group.push(calls[index + group.length]);
            index += group.length;
            if (group.length === 1 && !this.#concurrencySafe(view, group[0])) {
                await this.#locked(view.workspace ?? sessionId, () =>
                    this.#call(sessionId, runId, group[0], signal)
                );
                continue;
            }
            for (let start = 0; start < group.length; start += maxParallel)
                await Promise.all(
                    group
                        .slice(start, start + maxParallel)
                        .map(call => this.#call(sessionId, runId, call, signal))
                );
        }
    }

    /**
     * Record the user's answer to a permission ask and release the waiting call.
     * @param sessionId The session.
     * @param callId The call.
     * @param decision Allow or deny.
     * @param scope Once, or for the rest of the session.
     */
    async decide(
        sessionId: string,
        callId: string,
        decision: 'allow' | 'deny',
        scope: 'once' | 'session'
    ): Promise<void> {
        await this.#exec(sessionId, { type: 'decide-permission', callId, decision, scope });
        this.#waiters.get(callId)?.({ decision });
    }

    /** Cancel every job without committing; recovery records them as lost. */
    async shutdown(): Promise<void> {
        this.#closing = true;
        for (const job of this.#jobs.values())
            job.controller.abort(new Error('Whim is shutting down.'));
        await Promise.race([
            Promise.allSettled([...this.#jobs.values()].map(job => job.done)),
            new Promise(resolve => setTimeout(resolve, cancelGraceMs)),
        ]);
    }

    /**
     * Whether a call may run alongside its neighbours.
     * @param view The session view.
     * @param call The call.
     * @returns True for concurrency-safe tools and for calls that will fail validation.
     */
    #concurrencySafe(view: SessionView, call: OpenCall): boolean {
        const tool = this.#resolveTool(view, call.name);
        return tool === undefined || tool.concurrencySafe;
    }

    /**
     * Find the executable for a declared tool.
     * @param view The session view.
     * @param name The tool name.
     * @returns The definition, or undefined when not declared or no longer registered.
     */
    #resolveTool(view: SessionView, name: string): ToolDefinition<unknown> | undefined {
        if (!view.epoch.tools.some(tool => tool.name === name)) return undefined;
        return (
            this.#builtins.find(tool => tool.name === name) ??
            this.host.tools.get(name)?.tool ??
            this.dynamic.tool(name)
        );
    }

    /**
     * Validate a call's arguments.
     * @param view The session view.
     * @param call The call.
     * @returns The tool and input, or the error text for the model.
     */
    #resolve(view: SessionView, call: OpenCall): Resolved | { error: string } {
        if (!view.epoch.tools.some(tool => tool.name === call.name))
            return { error: `There is no tool named ${call.name}.` };
        const builtin = this.#builtins.find(item => item.name === call.name);
        const registered = builtin ? undefined : this.host.tools.get(call.name);
        // Dynamic tools (MCP) carry the server's own schema, which the server validates.
        const tool = builtin ?? registered?.tool ?? this.dynamic.tool(call.name);
        if (!tool) return { error: `The tool ${call.name} is not available right now.` };
        let input: unknown;
        try {
            input = JSON.parse(call.arguments || '{}');
        } catch (error) {
            return { error: `The arguments are not valid JSON: ${describeError(error)}` };
        }
        if (typeof input !== 'object' || input === null || Array.isArray(input))
            return { error: 'The arguments must be a JSON object.' };
        const schema = registered?.inputSchema ?? this.#builtinSchemas.get(call.name);
        const issues = schema?.issues(input) ?? [];
        if (issues.length)
            return {
                error: `Invalid arguments: ${issues.map(issue => `${issue.path} ${issue.message}`).join('; ')}`,
            };
        return { tool, input };
    }

    /**
     * Take a call from validation to its committed result.
     * @param sessionId The session.
     * @param runId The run.
     * @param call The call.
     * @param signal Run interruption.
     */
    async #call(
        sessionId: string,
        runId: string,
        call: OpenCall,
        signal: AbortSignal
    ): Promise<void> {
        if (signal.aborted) return;
        const view = await this.store.view(sessionId);
        const finish = (
            status: ToolResult['status'],
            content: string,
            extra: Partial<ToolResult> = {}
        ) => this.#finish(sessionId, call, status, content, extra);
        const resolved = this.#resolve(view, call);
        if ('error' in resolved) {
            await finish('error', resolved.error);
            return;
        }
        const { tool, input } = resolved;
        const env = view.workspace ? { workspace: view.workspace } : {};
        let access;
        try {
            access = tool.access(input, env);
        } catch (error) {
            await finish('error', describeError(error));
            return;
        }
        const verdict = evaluate(call.name, access, view.permissionRules, {
            ...env,
            readable: [
                this.sessionDir(sessionId),
                ...(this.legacyArtifactsDir ? [this.legacyArtifactsDir] : []),
            ],
        });
        // TODO(rules): persistent allow/deny/ask rules join `evaluate` as the step before asking,
        // with a Bash parser that matches each simple command of a compound one (agent.md §10).
        if (verdict === 'ask') {
            const answer = new Promise<Decision>(resolve =>
                this.#waiters.set(call.callId, resolve)
            );
            let reviewer: Reviewer | undefined;
            let unavailable: Failure | undefined;
            try {
                reviewer = await this.reviewer();
            } catch (error) {
                unavailable = failureOf(error);
            }
            await this.#exec(sessionId, {
                type: 'request-permission',
                runId,
                callId: call.callId,
                access: [...access],
                ...(reviewer ? { reviewer: { cardId: reviewer.cardId } } : {}),
            });
            if (unavailable) console.error('Automatic review is unavailable:', unavailable);
            if (reviewer) {
                const review = await this.#review(
                    sessionId,
                    call.callId,
                    reviewer,
                    reviewRequest(view, call.name, input, access),
                    signal
                );
                if (review === undefined) {
                    this.#waiters.delete(call.callId);
                    return;
                }
                if (review.outcome === 'deny') {
                    this.#waiters.delete(call.callId);
                    await finish(
                        'denied',
                        `The automatic reviewer denied this tool call: ${review.reason} Do not retry the same call; choose another way or ask the user.`
                    );
                    return;
                }
                if (review.outcome === 'allow')
                    this.#waiters.get(call.callId)?.({ decision: 'allow' });
            }
            const outcome = await race(answer, undefined, signal);
            this.#waiters.delete(call.callId);
            if (outcome.kind !== 'done' || outcome.value.decision === 'cancelled') return;
            if (outcome.value.decision === 'deny') {
                await finish('denied', 'The user denied this tool call.');
                return;
            }
        }
        const standard = tool.standard;
        const execute =
            standard && view.epoch.providerTools.includes(standard)
                ? (args: unknown, context: ToolContext) =>
                      this.#runOnProvider(view, standard, args, context)
                : async (args: unknown, context: ToolContext) =>
                      tool.execute(args, {
                          ...context,
                          ...(tool.credentialType
                              ? { credential: await this.#credentialFor(tool.credentialType) }
                              : {}),
                      });
        const job = await this.#startJob(
            sessionId,
            runId,
            call,
            execute,
            input,
            env.workspace,
            knownFiles(view)
        );
        const limit = tool.backgroundAfterMs?.(input);
        const outcome = await race(job.done, limit, signal);
        if (outcome.kind === 'done') {
            this.#jobs.delete(job.jobId);
            const output = outcome.value;
            {
                await this.#finishWithOutput(sessionId, call, output, job.jobId);
                return;
            }
        }
        if (outcome.kind === 'aborted') {
            job.controller.abort(new Error('The user stopped the response.'));
            const settled = await race(job.done, cancelGraceMs, new AbortController().signal);
            this.#jobs.delete(job.jobId);
            const partial = settled.kind === 'done' ? settled.value.content : job.tail;
            {
                await finish(
                    'cancelled',
                    `The user stopped the response while this tool was running.${partial ? `\nOutput before stopping:\n${tailOf(partial, previewBytes)}` : ''}`,
                    { jobId: job.jobId }
                );
                return;
            }
        }
        await finish(
            'background',
            `Still running after ${Math.round((limit ?? 0) / 1000)} s, so it continues in the background as job ${job.jobId}. You will be notified when it ends. Use JobOutput to read its output and JobStop to cancel it.${job.tail ? `\nOutput so far:\n${tailOf(job.tail, previewBytes)}` : ''}`,
            { jobId: job.jobId }
        );
        void job.done.then(output => this.#endBackground(job, output));
    }

    /**
     * Run the reviewer and commit its answer. A failure is committed as `ask` with the failure,
     * leaving the call to the user.
     * @param sessionId The session.
     * @param callId The call.
     * @param reviewer The reviewer.
     * @param request What it judges.
     * @param signal Run interruption; cancels the review without committing.
     * @returns The committed review, or undefined when the run was interrupted or the call
     * was settled otherwise.
     */
    async #review(
        sessionId: string,
        callId: string,
        reviewer: Reviewer,
        request: ReviewRequest,
        signal: AbortSignal
    ): Promise<Review | undefined> {
        const limit = AbortSignal.timeout(reviewTimeoutMs);
        let review: Review;
        let failure: Failure | undefined;
        try {
            review = await reviewer.review(request, AbortSignal.any([signal, limit]));
        } catch (error) {
            if (signal.aborted) return undefined;
            failure = limit.aborted
                ? {
                      category: 'timeout',
                      retry: { kind: 'never' },
                      outcome: 'unknown',
                      detail: {
                          provider: 'whim',
                          message: `The review took longer than ${reviewTimeoutMs / 1000} s.`,
                      },
                  }
                : failureOf(error);
            review = {
                outcome: 'ask',
                reason: boundText(failure.detail?.message ?? failure.category) ?? '',
                usage: {},
            };
        }
        if (signal.aborted) return undefined;
        try {
            await this.#exec(sessionId, {
                type: 'review-permission',
                callId,
                outcome: review.outcome,
                reason: boundText(review.reason) ?? '',
                usage: review.usage,
                ...(failure ? { failure } : {}),
            });
        } catch (error) {
            if (error instanceof StoreError && error.code === 'conflict') return undefined;
            throw error;
        }
        return review;
    }

    /**
     * Commit the start and launch the job.
     * @param sessionId The session.
     * @param runId The run.
     * @param call The call.
     * @param execute Runs the tool: its own implementation, or the provider's.
     * @param input Validated input.
     * @param workspace The session's workspace.
     * @param files The file versions in the model's context.
     * @returns The running job.
     */
    async #startJob(
        sessionId: string,
        runId: string,
        call: OpenCall,
        execute: (input: unknown, context: ToolContext) => Promise<ToolOutput>,
        input: unknown,
        workspace: string | undefined,
        files: ReadonlyMap<string, FileVersion>
    ): Promise<Job> {
        const jobId = randomUUID();
        await this.#exec(sessionId, { type: 'start-tool', runId, callId: call.callId, jobId });
        await mkdir(join(this.sessionDir(sessionId), 'jobs'), { recursive: true });
        const controller = new AbortController();
        const job: Job = {
            jobId,
            sessionId,
            callId: call.callId,
            name: call.name,
            controller,
            log: join(this.sessionDir(sessionId), 'jobs', `${jobId}.log`),
            writes: Promise.resolve(),
            bytes: 0,
            tail: '',
            done: Promise.resolve({ content: '' }),
        };
        const output = (chunk: string) => {
            if (!chunk) return;
            job.bytes += Buffer.byteLength(chunk);
            job.tail = tailOf(job.tail + chunk, previewBytes);
            job.writes = job.writes
                .then(() => appendFile(job.log, chunk))
                .catch(error => console.error(`Job ${jobId} output:`, describeError(error)));
        };
        job.done = execute(input, {
            signal: controller.signal,
            sessionId,
            callId: call.callId,
            ...(workspace ? { workspace } : {}),
            output,
            knownFiles: files,
        }).catch((error: unknown) => ({
            content: controller.signal.aborted
                ? `Cancelled: ${describeError(controller.signal.reason)}`
                : describeError(error),
            isError: true,
        }));
        this.#jobs.set(jobId, job);
        return job;
    }

    /**
     * The most recently added usable credential of a type.
     * @param typeId The credential type.
     * @returns The decrypted credential.
     */
    async #credentialFor(typeId: string): Promise<ResolvedCredential> {
        const match = (await this.credentials.list())
            .filter(item => item.typeId === typeId && item.available)
            .at(-1);
        if (!match) throw new Error('This tool needs a credential that is no longer configured.');
        return this.credentials.resolve(match.id);
    }

    /**
     * Run a standard tool through the session's adapter as a separate provider call and record
     * its token usage. The call has its own context; only its usage joins the session's.
     * @param view The session view when the call started.
     * @param standard The standard tool id.
     * @param input Validated input.
     * @param context The tool context.
     * @returns The tool output.
     */
    async #runOnProvider(
        view: SessionView,
        standard: string,
        input: unknown,
        context: ToolContext
    ): Promise<ToolOutput> {
        const session = await this.models.open(view.epoch.card, view.credentialId);
        if (!session.runTool) throw new Error(`The model provider cannot run ${standard} now.`);
        const thinking = toolThinking(view);
        // #resolve admitted only JSON objects.
        const result = await session.runTool(standard, input as Record<string, unknown>, {
            signal: context.signal,
            ...(thinking ? { thinking } : {}),
        });
        await this.#exec(context.sessionId, {
            type: 'record-tool-usage',
            callId: context.callId,
            usage: result.usage,
        });
        return result.output;
    }

    /**
     * Commit the end of a background job and let the session react.
     * @param job The job.
     * @param output Its final output.
     */
    async #endBackground(job: Job, output: ToolOutput): Promise<void> {
        this.#jobs.delete(job.jobId);
        if (this.#closing) return;
        await job.writes;
        const status = job.controller.signal.aborted
            ? 'cancelled'
            : output.isError
              ? 'failed'
              : 'completed';
        const text = tailOf(output.content || job.tail, previewBytes);
        try {
            await this.#exec(job.sessionId, {
                type: 'end-job',
                jobId: job.jobId,
                status,
                text:
                    Buffer.byteLength(output.content) > previewBytes
                        ? `${text}\n(Showing the last ${previewBytes / 1024} KiB; use JobOutput for the rest.)`
                        : text,
                observedAt: new Date().toISOString(),
            });
            this.onJobEnded(job.sessionId);
        } catch (error) {
            console.error(`Cannot record the end of job ${job.jobId}:`, describeError(error));
        }
    }

    /**
     * Commit a result from tool output, offloading it when large.
     * @param sessionId The session.
     * @param call The call.
     * @param output The tool output.
     * @param jobId The job that produced it.
     * @returns Resolves once the result is committed.
     */
    async #finishWithOutput(
        sessionId: string,
        call: OpenCall,
        output: ToolOutput,
        jobId: string
    ): Promise<void> {
        const media = [];
        for (const item of output.media ?? [])
            media.push(
                await storeMedia(
                    join(this.sessionDir(sessionId), 'media'),
                    item.data,
                    item.mediaType,
                    {
                        ...(item.name ? { name: item.name } : {}),
                    }
                )
            );
        const withMedia = {
            ...(media.length ? { media } : {}),
            ...(output.files?.length ? { files: [...output.files] } : {}),
        };
        const status = output.isError ? 'error' : 'success';
        const bytes = Buffer.byteLength(output.content);
        if (bytes <= maxResultBytes)
            return this.#finish(sessionId, call, status, output.content, { jobId, ...withMedia });
        const dir = join(this.sessionDir(sessionId), 'offload');
        const path = join(dir, `${call.callId.replace(/[^A-Za-z0-9_-]/g, '_')}.txt`);
        await mkdir(dir, { recursive: true });
        await writeFile(path, output.content);
        const encoded = Buffer.from(output.content);
        const head = encoded.subarray(0, previewBytes).toString('utf8').replace(/�+$/, '');
        const tail = tailOf(output.content, previewBytes);
        return this.#finish(
            sessionId,
            call,
            status,
            `${head}\n\n[… ${bytes - 2 * previewBytes} bytes omitted. The full output (${bytes} bytes) is at ${pathToFileURL(path).href}; read it with Read and an offset.]\n\n${tail}`,
            { jobId, offload: { path, bytes }, ...withMedia }
        );
    }

    /**
     * Commit a call's result.
     * @param sessionId The session.
     * @param call The call.
     * @param status Result status.
     * @param content Text for the model.
     * @param extra Job and offload references.
     */
    async #finish(
        sessionId: string,
        call: OpenCall,
        status: ToolResult['status'],
        content: string,
        extra: Partial<ToolResult> = {}
    ): Promise<void> {
        await this.#exec(sessionId, {
            type: 'finish-tool',
            result: {
                type: 'tool_result',
                id: randomUUID(),
                callId: call.callId,
                name: call.name,
                status,
                content,
                ...(extra.jobId ? { jobId: extra.jobId } : {}),
                ...(extra.offload ? { offload: extra.offload } : {}),
                ...(extra.media?.length ? { media: extra.media } : {}),
                ...(extra.files?.length ? { files: extra.files } : {}),
            },
        });
    }

    /**
     * Run work exclusively per key.
     * @param key The workspace or session.
     * @param work The work.
     */
    async #locked(key: string, work: () => Promise<void>): Promise<void> {
        const previous = this.#locks.get(key) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>(resolve => (release = resolve));
        const chained = previous.then(() => current);
        this.#locks.set(key, chained);
        await previous;
        try {
            await work();
        } finally {
            release();
            if (this.#locks.get(key) === chained) this.#locks.delete(key);
        }
    }

    /**
     * Execute a command with a fresh operation id.
     * @param sessionId The session.
     * @param command The command body.
     * @returns Produced records.
     */
    #exec(sessionId: string, command: DistributiveOmit<Command, 'sessionId' | 'operationId'>) {
        return this.store.execute({ ...command, sessionId, operationId: randomUUID() } as Command);
    }

    /**
     * The JobOutput tool.
     * @returns Its definition.
     */
    #jobOutputTool(): ToolDefinition<unknown> {
        return {
            name: 'JobOutput',
            description:
                'Read the output of a background job by byte offset. Returns up to 32 KiB and the offset to continue from.',
            inputSchema: jobOutputSchema,
            readOnly: true,
            concurrencySafe: true,
            needsWorkspace: false,
            access: () => [],
            execute: async (input, context) => {
                const { jobId, offset = 0 } = z
                    .object({
                        jobId: z.string(),
                        offset: z.number().int().nonnegative().optional(),
                    })
                    .parse(input);
                const job = this.#jobs.get(jobId);
                await job?.writes;
                const path = join(
                    this.sessionDir(context.sessionId),
                    'jobs',
                    `${jobId.replace(/[^A-Za-z0-9-]/g, '')}.log`
                );
                let handle;
                try {
                    handle = await open(path, 'r');
                } catch {
                    return { content: `There is no output for job ${jobId}.`, isError: true };
                }
                try {
                    const { size } = await handle.stat();
                    const buffer = Buffer.alloc(
                        Math.max(0, Math.min(maxJobOutputRead, size - offset))
                    );
                    await handle.read(buffer, 0, buffer.length, offset);
                    const next = offset + buffer.length;
                    return {
                        content: `${buffer.toString('utf8')}\n[Job ${job ? 'running' : 'finished'}; bytes ${offset}–${next} of ${size}${next < size ? `; continue with offset ${next}` : ''}.]`,
                    };
                } finally {
                    await handle.close();
                }
            },
        };
    }

    /**
     * The JobStop tool.
     * @returns Its definition.
     */
    #jobStopTool(): ToolDefinition<unknown> {
        return {
            name: 'JobStop',
            description: 'Cancel a running background job.',
            inputSchema: jobStopSchema,
            readOnly: false,
            concurrencySafe: true,
            needsWorkspace: false,
            access: () => [],
            execute: async input => {
                const { jobId } = z.object({ jobId: z.string() }).parse(input);
                const job = this.#jobs.get(jobId);
                if (!job) return { content: `Job ${jobId} is not running.`, isError: true };
                job.controller.abort(new Error('Stopped with JobStop.'));
                return {
                    content: `Job ${jobId} was asked to stop; you will be notified when it ends.`,
                };
            },
        };
    }
}

/**
 * The failure of a review that threw.
 * @param error What it threw.
 * @returns The normalized failure.
 */
function failureOf(error: unknown): Failure {
    if (error instanceof ApplicationError) return error.failure;
    return {
        category: 'internal',
        retry: { kind: 'never' },
        outcome: 'unknown',
        detail: { provider: 'whim', message: boundText(describeError(error)) ?? 'Unknown error.' },
    };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
