import { randomUUID } from 'node:crypto';

import { ApplicationError, selectableLevels } from '@whimkit/core/contracts';

import { estimateTokens, toRequestMessages } from './render.js';

import type { Command } from '@whimkit/core';
import type {
    AgentRecord,
    Block,
    Failure,
    FrozenChatCard,
    SessionView,
    Usage,
} from '@whimkit/core/contracts';
import type { ChatEvent, ChatRequest, ChatSession } from '@whimkit/core/plugin';

/** Persistence port; Core's Store implements it. */
export interface AgentStore {
    execute(command: Command): Promise<AgentRecord[]>;
    view(sessionId: string): Promise<SessionView>;
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
}

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
    { kind: 'completed' } | { kind: 'interrupted' } | { kind: 'failed'; failure: Failure };

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

    /**
     * Create an agent over its ports.
     * @param store Persistence.
     * @param models Model binding.
     * @param options Retry and timing policy.
     */
    constructor(
        private readonly store: AgentStore,
        private readonly models: AgentModels,
        options: AgentOptions = {}
    ) {
        this.#retry = options.retry ?? defaultRetry;
        this.#idleTimeoutMs = options.idleTimeoutMs ?? 120_000;
        this.#sleep = options.sleep ?? abortableSleep;
        this.#random = options.random ?? Math.random;
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
        trigger: 'user' | 'continue' | 'restart',
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
                const outcome = yield* this.#step(view, runId, stepId, signal);
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
     * Run one reasoning step, retrying failed attempts per policy.
     * @param view The view after the step was prepared.
     * @param runId The run.
     * @param stepId The step.
     * @param signal Run interruption.
     * @yields Transient stream events.
     * @returns How the step ended.
     */
    async *#step(
        view: SessionView,
        runId: string,
        stepId: string,
        signal: AbortSignal
    ): AsyncGenerator<AgentEvent, StepOutcome> {
        const sessionId = view.sessionId;
        const card = view.epoch.card;
        const levels = selectableLevels(card.thinking);
        const thinking =
            view.thinking && levels.includes(view.thinking)
                ? view.thinking
                : defaultLevel(card.thinking);
        const request: ChatRequest = {
            system: view.epoch.system,
            messages: toRequestMessages(view.history),
            ...(thinking ? { thinking } : {}),
        };
        let session: ChatSession;
        try {
            session = await this.models.open(card, view.credentialId);
        } catch (error) {
            return { kind: 'failed', failure: toFailure(error) };
        }
        const estimate = session.countTokens
            ? await session.countTokens(request, signal)
            : estimateTokens(request.system, request.messages);
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
                            blocks: outputBlocks(reasoning, continuations, text),
                        },
                    },
                });
                return { kind: 'completed' };
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
                                blocks: outputBlocks(reasoning, [], text),
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
 * @returns Output blocks without empty parts.
 */
function outputBlocks(reasoning: string[], continuations: Block[], text: string[]): Block[] {
    const blocks: Block[] = [];
    if (reasoning.length) blocks.push({ type: 'reasoning', text: reasoning.join('') });
    blocks.push(...continuations);
    if (text.length) blocks.push({ type: 'text', text: text.join('') });
    return blocks;
}
