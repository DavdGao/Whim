import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ApplicationError, selectableLevels } from '@whimkit/core/contracts';

import {
    compactionCut,
    correctionHint,
    longestText,
    olderHalf,
    parseSummary,
    summaryHint,
    trimLongTexts,
} from './compaction.js';
import { epochMessages, estimateTokens, transcriptText } from './render.js';

import type { CompactionCut, SummaryProblem } from './compaction.js';
import type { MediaPolicy } from './render.js';
import type { Command } from '@whimkit/core';
import type {
    AgentRecord,
    Block,
    EpochContext,
    Failure,
    FrozenChatCard,
    SessionView,
    Usage,
} from '@whimkit/core/contracts';
import type { ChatEvent, ChatRequest, ChatRequestMessage, ChatSession } from '@whimkit/core/plugin';

/** Persistence port; Core's Store implements it. */
export interface AgentStore {
    execute(command: Command): Promise<AgentRecord[]>;
    view(sessionId: string): Promise<SessionView>;
}

/** Tool port; Core's ToolRuntime implements it. */
export interface AgentTools {
    /**
     * Execute the open calls of the current step, committing one result for each. Returns
     * early when the run is interrupted.
     */
    run(sessionId: string, runId: string, signal: AbortSignal): Promise<void>;
}

/** Model port; Core's ModelService implements it. */
export interface AgentModels {
    open(card: FrozenChatCard, credentialId: string): Promise<ChatSession>;
}

export interface RetryPolicy {
    readonly maxAttempts: number;
    readonly baseDelayMs: number;
    readonly maxDelayMs: number;
}

export interface AgentOptions {
    readonly retry?: RetryPolicy;
    /** Abort an attempt after this long without a stream event. */
    readonly idleTimeoutMs?: number;
    readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    readonly random?: () => number;
    /** Read stored media by `file:` URI; the file system by default. */
    readonly readMedia?: (uri: string) => Promise<Uint8Array>;
    /** Enables automatic compaction; without it, an oversized context fails the step. */
    readonly compaction?: AgentCompaction;
    /** The current time, told to the model when it summarizes. */
    readonly now?: () => Date;
}

/** What compaction needs from the host. */
export interface AgentCompaction {
    /** Absolute path of the session's conversation file, inside its own folder. */
    transcriptPath(sessionId: string): string;
    /** The prefix of the epoch after a compaction: the current prompt, tools, and model. */
    epoch(view: SessionView): Promise<Extract<Command, { type: 'switch-model' }>['epoch']>;
}

/** Compaction starts once a request would exceed this share of the context window. */
export const compactionShare = 0.8;

/** The tail a compaction keeps verbatim takes at most this share of the threshold. */
const tailShare = 0.25;

/** A step compacts at most this many times, each committing a new epoch. */
const maxCompactionsPerStep = 3;

/** One compaction sends at most this many summary requests. */
const maxSummaryRequests = 12;

/** Shortening texts of a refused summary request stops below this many characters. */
const minTrimmedChars = 2000;

/**
 * Transient events for subscribers; never stored. Committed records reach subscribers through
 * the store's commit notifications instead.
 */
export type AgentEvent =
    | {
          readonly type: 'stream';
          readonly sessionId: string;
          readonly attemptId: string;
          readonly part: 'text' | 'reasoning';
          readonly text: string;
      }
    | {
          readonly type: 'discarded';
          readonly sessionId: string;
          readonly attemptId: string;
          readonly failure: Failure;
      };

type StepOutcome =
    | { kind: 'completed' }
    | { kind: 'tools' }
    | { kind: 'interrupted' }
    | { kind: 'failed'; failure: Failure }
    /**
     * Compact and run the step again: the estimate passed the threshold before sending, or the
     * provider rejected the request with `failure` (`context-limit`) despite the estimate.
     */
    | { kind: 'compact'; failure?: Failure };

const defaultRetry: RetryPolicy = { maxAttempts: 4, baseDelayMs: 1000, maxDelayMs: 30_000 };

/**
 * Sleep until the delay elapses or the signal aborts.
 * @param ms Delay in milliseconds.
 * @param signal Cancellation.
 */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * Normalize anything thrown during an attempt.
 * @param error The thrown value.
 * @returns A failure.
 */
function toFailure(error: unknown): Failure {
    if (error instanceof ApplicationError) return error.failure;
    return {
        category: 'internal',
        retry: { kind: 'never' },
        outcome: 'unknown',
        detail: {
            provider: 'whim',
            message: error instanceof Error ? error.message : String(error),
        },
    };
}

/** Runs sessions: prepares steps, streams model attempts, retries, and honors interruption. */
export class Agent {
    readonly #retry: RetryPolicy;
    readonly #idleTimeoutMs: number;
    readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
    readonly #random: () => number;
    readonly #readMedia: (uri: string) => Promise<Uint8Array>;
    readonly #compaction: AgentCompaction | undefined;
    readonly #now: () => Date;

    /**
     * Create an agent over its ports.
     * @param store Persistence.
     * @param models Model binding.
     * @param tools Tool execution.
     * @param options Retry and timing policy.
     */
    constructor(
        private readonly store: AgentStore,
        private readonly models: AgentModels,
        private readonly tools: AgentTools,
        options: AgentOptions = {}
    ) {
        this.#retry = options.retry ?? defaultRetry;
        this.#idleTimeoutMs = options.idleTimeoutMs ?? 120_000;
        this.#sleep = options.sleep ?? abortableSleep;
        this.#random = options.random ?? Math.random;
        this.#readMedia = options.readMedia ?? (uri => readFile(fileURLToPath(uri)));
        this.#compaction = options.compaction;
        this.#now = options.now ?? (() => new Date());
    }

    /**
     * Execute a command with a fresh operation id.
     * @param sessionId The session.
     * @param command The command body.
     * @returns Produced records.
     */
    #exec(
        sessionId: string,
        command: DistributiveOmit<Command, 'sessionId' | 'operationId'>
    ): Promise<AgentRecord[]> {
        return this.store.execute({ ...command, sessionId, operationId: randomUUID() } as Command);
    }

    /**
     * Run a session until it has nothing left to respond to, is interrupted, or fails.
     * Interruption is requested by committing `interrupt` first and then aborting `signal`.
     * @param sessionId The session.
     * @param trigger What started the run.
     * @param signal Aborted when the run is interrupted.
     * @yields Transient stream events.
     */
    async *run(
        sessionId: string,
        trigger: 'user' | 'continue' | 'restart' | 'job' | 'schedule' | 'message',
        signal: AbortSignal
    ): AsyncGenerator<AgentEvent> {
        const runId = randomUUID();
        const started = await this.#exec(sessionId, { type: 'start-run', runId, trigger });
        if (started.length === 0) return;
        let result: Extract<Command, { type: 'end-run' }>['result'] = { outcome: 'completed' };
        try {
            let first = true;
            while (true) {
                if (signal.aborted) {
                    result = { outcome: 'interrupted', reason: 'user' };
                    break;
                }
                const stepId = randomUUID();
                const prepared = await this.#exec(sessionId, {
                    type: 'prepare-step',
                    runId,
                    stepId,
                });
                if (prepared.length === 0) break;
                const view = await this.store.view(sessionId);
                if (first && !needsResponse(view)) break;
                first = false;
                let outcome = yield* this.#step(view, runId, stepId, signal, true);
                for (let compactions = 1; outcome.kind === 'compact'; compactions++) {
                    const compacted = await this.#compact(
                        await this.store.view(sessionId),
                        runId,
                        signal
                    );
                    if (signal.aborted) {
                        outcome = { kind: 'interrupted' };
                        break;
                    }
                    // The provider already refused this context; sending it unchanged cannot work.
                    if (!compacted && outcome.failure) {
                        outcome = { kind: 'failed', failure: outcome.failure };
                        break;
                    }
                    outcome = yield* this.#step(
                        await this.store.view(sessionId),
                        runId,
                        stepId,
                        signal,
                        compacted && compactions < maxCompactionsPerStep
                    );
                }
                if (outcome.kind === 'interrupted') {
                    result = {
                        outcome: 'interrupted',
                        reason: (await this.store.view(sessionId)).run?.interrupt ?? 'user',
                    };
                    break;
                }
                if (outcome.kind === 'failed') {
                    result = { outcome: 'failed', failure: outcome.failure };
                    break;
                }
                if (outcome.kind === 'tools') {
                    await this.tools.run(sessionId, runId, signal);
                    if (signal.aborted) {
                        result = {
                            outcome: 'interrupted',
                            reason: (await this.store.view(sessionId)).run?.interrupt ?? 'user',
                        };
                        break;
                    }
                }
            }
        } catch (error) {
            result = signal.aborted
                ? { outcome: 'interrupted', reason: 'user' }
                : { outcome: 'failed', failure: toFailure(error) };
        } finally {
            const view = await this.store.view(sessionId);
            if (view.run?.runId === runId) {
                if (view.run.attempt)
                    await this.#exec(sessionId, {
                        type: 'finish-attempt',
                        attemptId: view.run.attempt.attemptId,
                        usage: {},
                        result: {
                            status: 'failed',
                            failure:
                                result.outcome === 'failed'
                                    ? result.failure
                                    : toFailure(new Error('Run ended.')),
                        },
                    });
                if (result.outcome === 'interrupted' && view.run.interrupt)
                    result = { outcome: 'interrupted', reason: view.run.interrupt };
                await this.#exec(sessionId, { type: 'end-run', runId, result });
            }
        }
    }

    /**
     * Compact the current epoch: ask for a tagged summary in the step's own request cut before
     * the kept tail, write the covered history into the session's folder, and commit a new epoch
     * that starts from the summary (agent.md §8). Failure keeps the current epoch.
     * @param view The session view after the step consumed its input.
     * @param runId The active run.
     * @param signal Run interruption.
     * @returns Whether a new epoch was committed.
     */
    async #compact(view: SessionView, runId: string, signal: AbortSignal): Promise<boolean> {
        const port = this.#compaction;
        if (!port) return false;
        const sessionId = view.sessionId;
        const card = view.epoch.card;
        let session: ChatSession;
        try {
            session = await this.models.open(card, view.credentialId);
        } catch {
            return false;
        }
        const threshold = Math.min(
            session.inputBudget(),
            Math.floor(card.contextWindow * compactionShare)
        );
        const first = compactionCut(view, Math.floor(threshold * tailShare));
        if (!first) return false;
        let cut: CompactionCut = first;
        const compactionId = randomUUID();
        await this.#exec(sessionId, { type: 'start-compaction', runId, compactionId });
        try {
            const thinking = stepThinking(view);
            const hint = summaryHint(this.#now());
            // Set once the covered part is a single entry and still too long.
            let trim: number | undefined;
            let retry: { reply: string; problem: SummaryProblem } | undefined;
            let summary: string | undefined;
            for (let requests = 0; summary === undefined; requests++) {
                if (requests >= maxSummaryRequests)
                    throw new Error('The summary request was refused too often.');
                const history = await epochMessages(view, this.#media(session, card), cut.from);
                const messages: ChatRequestMessage[] = [
                    ...history,
                    { role: 'user', blocks: [{ type: 'text', text: hint }] },
                ];
                if (retry) {
                    if (retry.reply)
                        messages.push({
                            role: 'assistant',
                            blocks: [{ type: 'text', text: retry.reply }],
                        });
                    messages.push({
                        role: 'user',
                        blocks: [{ type: 'text', text: correctionHint(retry.problem) }],
                    });
                }
                const request: ChatRequest = {
                    system: view.epoch.system,
                    messages:
                        trim === undefined
                            ? messages
                            : trimLongTexts(messages, trim, messages.length - history.length),
                    ...(thinking ? { thinking } : {}),
                    tools: view.epoch.tools,
                    nativeTools: view.epoch.nativeTools,
                };
                const estimate = session.countTokens
                    ? await session.countTokens(request, signal)
                    : estimateTokens(request.system, request.messages, request.tools);
                const reply =
                    estimate > session.inputBudget()
                        ? undefined
                        : await this.#summaryAttempt(
                              sessionId,
                              session,
                              request,
                              compactionId,
                              signal
                          );
                if (!reply || reply.failure?.category === 'context-limit') {
                    // Summarize the older half; a single entry is shortened in the middle instead.
                    retry = undefined;
                    const half = trim === undefined ? olderHalf(view, cut) : undefined;
                    if (half) cut = half;
                    else {
                        trim = Math.floor((trim ?? longestText(request.messages)) / 2);
                        if (trim < minTrimmedChars)
                            throw reply?.failure
                                ? new ApplicationError(reply.failure)
                                : new Error('The summary request does not fit the input budget.');
                    }
                    continue;
                }
                if (reply.failure && reply.failure.category !== 'output-limit')
                    throw new ApplicationError(reply.failure);
                const parsed = parseSummary(reply.text);
                const problem: SummaryProblem | undefined = reply.failure
                    ? { kind: 'cut' }
                    : reply.called
                      ? { kind: 'tool-call' }
                      : parsed.missing.length
                        ? { kind: 'missing', sections: parsed.missing }
                        : undefined;
                if (!problem) summary = parsed.summary;
                else if (!retry) retry = { reply: reply.text, problem };
                else if (parsed.missing.length === 0) summary = parsed.summary;
                else if (reply.text) summary = reply.text;
                else throw new Error('The summary came back empty.');
            }

            // The file holds everything before the cut and grows with each compaction. It is
            // written whole from the journal and renamed into place before anything refers to it,
            // so a crash between writing and committing leaves no partial or repeated part.
            const path = port.transcriptPath(sessionId);
            await mkdir(dirname(path), { recursive: true });
            const staged = `${path}.${compactionId}.tmp`;
            try {
                await writeFile(
                    staged,
                    `${transcriptText(view.history.filter(entry => entry.seq < cut.from))}\n`
                );
                await rename(staged, path);
            } finally {
                await rm(staged, { force: true });
            }
            const epoch = await port.epoch(view);
            await this.#exec(sessionId, {
                type: 'finish-compaction',
                compactionId,
                result: {
                    status: 'succeeded',
                    epoch: { ...epoch, context: epochContext(summary, cut, path) },
                },
            });
            return true;
        } catch (error) {
            await this.#exec(sessionId, {
                type: 'finish-compaction',
                compactionId,
                result: { status: 'failed', failure: toFailure(error) },
            });
            return false;
        }
    }

    /**
     * Send one summary request and record it with its usage.
     * @param sessionId The session.
     * @param session The model session.
     * @param request The request.
     * @param compactionId The running compaction.
     * @param signal Run interruption.
     * @returns The reply's text, whether it called a tool, and the failure, if any.
     */
    async #summaryAttempt(
        sessionId: string,
        session: ChatSession,
        request: ChatRequest,
        compactionId: string,
        signal: AbortSignal
    ): Promise<{ text: string; called: boolean; failure?: Failure }> {
        let text = '';
        let called = false;
        let usage: Usage = {};
        const attempt = new AbortController();
        const onAbort = () => attempt.abort(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        try {
            for await (const event of this.#withIdleTimeout(
                session.stream(request, attempt.signal),
                attempt
            ))
                if (event.type === 'text-delta') text += event.text;
                else if (event.type === 'tool-call') called = true;
                else if (event.type === 'completed') usage = event.usage;
        } catch (error) {
            const failure = toFailure(error);
            await this.#exec(sessionId, {
                type: 'record-compaction-attempt',
                compactionId,
                usage,
                failure,
            });
            if (signal.aborted) throw error;
            return { text: text.trim(), called, failure };
        } finally {
            signal.removeEventListener('abort', onAbort);
        }
        await this.#exec(sessionId, { type: 'record-compaction-attempt', compactionId, usage });
        return { text: text.trim(), called };
    }

    /**
     * How media in history reach requests of a model session.
     * @param session The model session.
     * @param card The session's card.
     * @returns The media policy.
     */
    #media(session: ChatSession, card: FrozenChatCard): MediaPolicy {
        return {
            accepts: mediaType => mediaType in card.input,
            inToolResults: session.toolResultMedia ?? [],
            read: this.#readMedia,
        };
    }

    /**
     * Run one reasoning step, retrying failed attempts per policy.
     * @param view The view after the step was prepared.
     * @param runId The run.
     * @param stepId The step.
     * @param signal Run interruption.
     * @param canCompact Whether the step may still compact.
     * @yields Transient stream events.
     * @returns How the step ended.
     */
    async *#step(
        view: SessionView,
        runId: string,
        stepId: string,
        signal: AbortSignal,
        canCompact: boolean
    ): AsyncGenerator<AgentEvent, StepOutcome> {
        const sessionId = view.sessionId;
        const card = view.epoch.card;
        const thinking = stepThinking(view);
        const compactable =
            canCompact && this.#compaction !== undefined && compactionCut(view, 0) !== undefined;
        let session: ChatSession;
        let request: ChatRequest;
        try {
            session = await this.models.open(card, view.credentialId);
            request = {
                system: view.epoch.system,
                messages: await epochMessages(view, this.#media(session, card)),
                ...(thinking ? { thinking } : {}),
                tools: view.epoch.tools,
                nativeTools: view.epoch.nativeTools,
            };
        } catch (error) {
            return { kind: 'failed', failure: toFailure(error) };
        }
        const estimate = session.countTokens
            ? await session.countTokens(request, signal)
            : estimateTokens(request.system, request.messages, request.tools);
        const threshold = Math.min(
            session.inputBudget(),
            Math.floor(card.contextWindow * compactionShare)
        );
        if (estimate > threshold && compactable) return { kind: 'compact' };
        if (estimate > session.inputBudget())
            return {
                kind: 'failed',
                failure: {
                    category: 'context-limit',
                    retry: { kind: 'after-change', change: 'input' },
                    outcome: 'rejected',
                    detail: {
                        provider: 'whim',
                        message: `About ${estimate} input tokens exceed the budget of ${session.inputBudget()}.`,
                    },
                },
            };
        for (let number = 1; ; number++) {
            if (signal.aborted) return { kind: 'interrupted' };
            const attemptId = randomUUID();
            await this.#exec(sessionId, {
                type: 'start-attempt',
                runId,
                stepId,
                attemptId,
                number,
            });
            const text: string[] = [];
            const reasoning: string[] = [];
            const continuations: Block[] = [];
            const natives: Block[] = [];
            const calls: Block[] = [];
            const thinking: { start?: number; end?: number } = {};
            let usage: Usage = {};
            let published = false;
            const attempt = new AbortController();
            const onAbort = () => attempt.abort(signal.reason);
            signal.addEventListener('abort', onAbort, { once: true });
            try {
                for await (const event of this.#withIdleTimeout(
                    session.stream(request, attempt.signal),
                    attempt
                )) {
                    if (event.type === 'text-delta' || event.type === 'reasoning-delta') {
                        (event.type === 'text-delta' ? text : reasoning).push(event.text);
                        if (event.type === 'reasoning-delta') thinking.start ??= performance.now();
                        else if (thinking.start !== undefined) thinking.end ??= performance.now();
                        published = true;
                        yield {
                            type: 'stream',
                            sessionId,
                            attemptId,
                            part: event.type === 'text-delta' ? 'text' : 'reasoning',
                            text: event.text,
                        };
                    } else if (event.type === 'continuation') {
                        continuations.push({
                            type: 'continuation',
                            adapter: card.adapter,
                            format: event.format,
                            data: event.data,
                        });
                    } else if (event.type === 'tool-call') {
                        calls.push({
                            type: 'tool_call',
                            callId: event.callId,
                            name: event.name,
                            arguments: event.arguments,
                        });
                    } else if (event.type === 'native-tool-call') {
                        const { type: _type, ...rest } = event;
                        natives.push({ type: 'native_tool_call', adapter: card.adapter, ...rest });
                    } else usage = event.usage;
                }
                await this.#exec(sessionId, {
                    type: 'finish-attempt',
                    attemptId,
                    usage,
                    result: {
                        status: 'completed',
                        output: {
                            messageId: randomUUID(),
                            blocks: [
                                ...outputBlocks(
                                    reasoning,
                                    [...continuations, ...natives],
                                    text,
                                    thinking
                                ),
                                ...calls,
                            ],
                        },
                    },
                });
                return calls.length ? { kind: 'tools' } : { kind: 'completed' };
            } catch (error) {
                if (signal.aborted) {
                    await this.#exec(sessionId, {
                        type: 'finish-attempt',
                        attemptId,
                        usage,
                        result: {
                            status: 'interrupted',
                            output: {
                                messageId: randomUUID(),
                                // Calls of an interrupted attempt are never executed.
                                blocks: outputBlocks(reasoning, natives, text, thinking),
                            },
                        },
                    });
                    return { kind: 'interrupted' };
                }
                const failure = toFailure(error);
                await this.#exec(sessionId, {
                    type: 'finish-attempt',
                    attemptId,
                    usage,
                    result: { status: 'failed', failure },
                });
                if (published) yield { type: 'discarded', sessionId, attemptId, failure };
                if (failure.category === 'context-limit' && compactable)
                    return { kind: 'compact', failure };
                if (failure.retry.kind !== 'backoff' || number >= this.#retry.maxAttempts)
                    return { kind: 'failed', failure };
                const delay = this.#delay(number, failure.retry.afterMs);
                await this.#exec(sessionId, {
                    type: 'schedule-retry',
                    runId,
                    stepId,
                    number: number + 1,
                    at: new Date(Date.now() + delay).toISOString(),
                    failure,
                });
                try {
                    await this.#sleep(delay, signal);
                } catch {
                    return { kind: 'interrupted' };
                }
            } finally {
                signal.removeEventListener('abort', onAbort);
            }
        }
    }

    /**
     * Backoff with jitter, honoring a provider-requested delay.
     * @param number The failed attempt number.
     * @param afterMs Provider-requested delay.
     * @returns Delay in milliseconds.
     */
    #delay(number: number, afterMs: number | undefined): number {
        const exponential = Math.min(
            this.#retry.maxDelayMs,
            this.#retry.baseDelayMs * 2 ** (number - 1)
        );
        const jittered = Math.round(exponential * (0.5 + this.#random() / 2));
        return Math.min(this.#retry.maxDelayMs, Math.max(afterMs ?? 0, jittered));
    }

    /**
     * Fail an attempt that produces no event for the idle timeout.
     * @param events The adapter stream.
     * @param attempt The attempt controller to abort on timeout.
     * @yields Events unchanged.
     */
    async *#withIdleTimeout(
        events: AsyncIterable<ChatEvent>,
        attempt: AbortController
    ): AsyncGenerator<ChatEvent> {
        const iterator = events[Symbol.asyncIterator]();
        let timedOut = false;
        try {
            while (true) {
                let timer: NodeJS.Timeout | undefined;
                const next = await Promise.race([
                    iterator.next(),
                    new Promise<never>((_, reject) => {
                        timer = setTimeout(() => {
                            timedOut = true;
                            attempt.abort(new Error('Idle timeout.'));
                            reject(
                                new ApplicationError({
                                    category: 'timeout',
                                    retry: { kind: 'backoff' },
                                    outcome: 'unknown',
                                    detail: {
                                        provider: 'whim',
                                        message: `No response for ${this.#idleTimeoutMs / 1000} s.`,
                                    },
                                })
                            );
                        }, this.#idleTimeoutMs);
                    }),
                ]).finally(() => clearTimeout(timer));
                if (next.done) return;
                yield next.value;
            }
        } finally {
            if (!timedOut) await iterator.return?.();
        }
    }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * Whether the history ends with something the model has not answered.
 * @param view The session view.
 * @returns True when a response is needed.
 */
function needsResponse(view: SessionView): boolean {
    const last = view.history.at(-1);
    return (
        last !== undefined &&
        !(
            last.item.type === 'message' &&
            last.item.role === 'assistant' &&
            last.status === 'completed'
        )
    );
}

/**
 * The card's default thinking level, if adjustable.
 * @param thinking The card's thinking field.
 * @returns The default level.
 */
function defaultLevel(thinking: unknown) {
    if (thinking && typeof thinking === 'object' && 'default' in thinking) {
        const levels = selectableLevels(thinking);
        return levels.find(level => level === thinking.default);
    }
    return undefined;
}

/**
 * Assemble output blocks in model order.
 * @param reasoning Reasoning deltas.
 * @param continuations Opaque continuation items.
 * @param text Text deltas.
 * @param thinking Monotonic times of the first reasoning delta and the first answer delta.
 * @param thinking.start First reasoning delta.
 * @param thinking.end First answer delta after reasoning; the attempt's end when absent.
 * @returns Output blocks without empty parts.
 */
function outputBlocks(
    reasoning: string[],
    continuations: Block[],
    text: string[],
    thinking: { start?: number; end?: number }
): Block[] {
    const blocks: Block[] = [];
    if (reasoning.length)
        blocks.push({
            type: 'reasoning',
            text: reasoning.join(''),
            ...(thinking.start !== undefined
                ? {
                      durationMs: Math.round((thinking.end ?? performance.now()) - thinking.start),
                  }
                : {}),
        });
    blocks.push(...continuations);
    if (text.length) blocks.push({ type: 'text', text: text.join('') });
    return blocks;
}

/**
 * The thinking level of the session's requests: the chosen one when the card offers it.
 * @param view The session view.
 * @returns The level, or undefined when the card's thinking is fixed.
 */
function stepThinking(view: SessionView) {
    const thinking = view.epoch.card.thinking;
    return view.thinking && selectableLevels(thinking).includes(view.thinking)
        ? view.thinking
        : defaultLevel(thinking);
}

/**
 * The context of the epoch a compaction starts.
 * @param summary The accepted summary.
 * @param cut Where the compaction cut.
 * @param transcript Path of the covered history's transcript.
 * @returns The epoch context.
 */
function epochContext(summary: string, cut: CompactionCut, transcript: string): EpochContext {
    return {
        summary,
        from: cut.from,
        transcript: pathToFileURL(transcript).href,
        ...(cut.input === undefined ? {} : { input: cut.input }),
    };
}
