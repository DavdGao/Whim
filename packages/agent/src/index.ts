import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import {
    ApplicationError,
    buildCompactionRequest,
    eligibleDeliveries,
    foldRecords,
    StoreError,
} from '@whimkit/core';
import { chatEventSchema, validateTextCard } from '@whimkit/models';

import type { Context } from '@opentelemetry/api';
import type { AgentRecord, AgentStore, Command, Epoch } from '@whimkit/core';
import type { ChatAdapter, ChatEvent, ChatRequest } from '@whimkit/models';

export interface RunOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
    compaction?: { epoch: Epoch; retainLast: number };
}

interface Execution {
    runId: string;
    generation: string;
    controller: AbortController;
    stopping: Promise<AgentRecord[]> | null;
}

/**
 * Await cancellable work without leaving abort listeners or unhandled late rejections.
 * @param work The pending operation, including any late rejection.
 * @param signal Cancellation for this operation.
 * @returns The operation result, or an abort rejection.
 */
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const abort = () => {
            signal.removeEventListener('abort', abort);
            reject(signal.reason);
        };
        signal.addEventListener('abort', abort, { once: true });
        work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
        if (signal.aborted) abort();
    });
}

/** Coordinate one durable text-agent runner per session through the Store port. */
export class Agent {
    private readonly active = new Map<string, Execution>();
    private readonly tracer = trace.getTracer('@whimkit/agent', '0.1.0');

    /**
     * Inject persistence and an explicit, replaceable model adapter.
     * @param store The authoritative asynchronous journal port.
     * @param model The adapter bound to the session model card.
     */
    constructor(
        private readonly store: AgentStore,
        private readonly model: ChatAdapter
    ) {
        validateTextCard(model.card);
    }

    /**
     * Seal the committed output cutoff before aborting the in-process model request.
     * @param sessionId The target session identity.
     * @param reason The durable interruption cause.
     * @returns The committed interruption records.
     */
    async interrupt(
        sessionId: string,
        reason: 'user' | 'aborted' | 'consumer-closed' = 'user'
    ): Promise<AgentRecord[]> {
        const execution = this.active.get(sessionId);
        if (!execution) throw new Error('This agent does not own the session runner.');
        if (!execution.stopping) {
            execution.stopping = this.store.execute({
                type: 'interrupt',
                sessionId,
                operationId: randomUUID(),
                runId: execution.runId,
                generation: execution.generation,
                reason,
            });
            // Cancellation must still unblock I/O if persistence fails; the caller receives that failure.
            execution.stopping.then(
                () => execution.controller.abort(),
                () => execution.controller.abort()
            );
        }
        return execution.stopping;
    }

    /**
     * Yield committed records; closing the iterator stops its run, not merely a UI subscription.
     * @param sessionId The target session identity.
     * @param options Cancellation, deadline, and optional compaction settings.
     */
    async *run(
        sessionId: string,
        options: RunOptions = {}
    ): AsyncGenerator<AgentRecord, void, void> {
        if (this.active.has(sessionId)) throw new Error('Session already has a local runner.');
        const timeoutMs = options.timeoutMs ?? 120000;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647)
            throw new Error('Invalid run timeout.');
        const deadline = AbortSignal.timeout(timeoutMs);
        const runSignal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
        const execution: Execution = {
            runId: randomUUID(),
            generation: randomUUID(),
            controller: new AbortController(),
            stopping: null,
        };
        const ownership = { sessionId, runId: execution.runId, generation: execution.generation };
        const span = this.tracer.startSpan(options.compaction ? 'agent.compaction' : 'agent.run', {
            attributes: { 'agent.session.id': sessionId, 'agent.run.id': execution.runId },
        });
        const runContext = trace.setSpan(context.active(), span);
        let started = false;
        let ended = false;
        let detach: () => void = () => undefined;
        this.active.set(sessionId, execution);
        try {
            runSignal.throwIfAborted();
            const start = await this.commit(
                { type: 'start', ...ownership, operationId: randomUUID() },
                runContext
            );
            started = true;
            const onAbort = () => {
                // The run's finally block awaits and reports this owned promise.
                void this.interrupt(sessionId, 'aborted').catch(() => undefined);
            };
            runSignal.addEventListener('abort', onAbort, { once: true });
            detach = () => runSignal.removeEventListener('abort', onAbort);
            if (runSignal.aborted) onAbort();
            yield* start;
            for (let step = 0; step < 32; step++) {
                execution.controller.signal.throwIfAborted();
                let view = foldRecords(await this.store.read(sessionId));
                if (!isDeepStrictEqual(view.epoch.card, validateTextCard(this.model.card))) {
                    throw new Error('The model adapter does not match the frozen epoch.');
                }
                const planId = randomUUID();
                if (options.compaction) {
                    const { epoch, retainLast } = options.compaction;
                    if (!Number.isSafeInteger(retainLast) || retainLast < 0)
                        throw new Error('Invalid compaction tail length.');
                    const retainedIds = retainLast
                        ? view.messages.slice(-retainLast).map(message => message.id)
                        : [];
                    yield* await this.commit(
                        {
                            type: 'compact',
                            ...ownership,
                            operationId: randomUUID(),
                            compactionId: planId,
                            epoch,
                            retainedIds,
                            expectedContextVersion: view.contextVersion,
                        },
                        runContext
                    );
                } else {
                    const deliveries = eligibleDeliveries(view).slice(0, 64);
                    const request: ChatRequest = {
                        card: view.epoch.card,
                        system: view.epoch.system,
                        messages: [...view.messages, ...deliveries.map(delivery => delivery.entry)],
                        purpose: 'chat',
                        ...(view.epoch.thinkingLevel
                            ? { thinkingLevel: view.epoch.thinkingLevel }
                            : {}),
                    };
                    const estimatedTokens = await this.admit(request, execution.controller.signal);
                    yield* await this.commit(
                        {
                            type: 'prepare',
                            ...ownership,
                            operationId: randomUUID(),
                            planId,
                            expectedContextVersion: view.contextVersion,
                            deliveryIds: deliveries.map(delivery => delivery.id),
                            estimatedTokens,
                        },
                        runContext
                    );
                }
                view = foldRecords(await this.store.read(sessionId));
                const plan = view.plans.get(planId);
                if (!plan) throw new Error('Committed plan is missing.');
                if (options.compaction) await this.admit(plan.request, execution.controller.signal);
                const attemptId = randomUUID();
                yield* await this.commit(
                    {
                        type: 'attempt',
                        ...ownership,
                        operationId: randomUUID(),
                        attemptId,
                        planId,
                        messageId: randomUUID(),
                        purpose: plan.request.purpose,
                    },
                    runContext
                );
                yield* this.generate(plan.request, attemptId, execution, sessionId, runContext);
                if (options.compaction) {
                    const candidate = buildCompactionRequest(
                        foldRecords(await this.store.read(sessionId)),
                        attemptId
                    );
                    await this.admit(candidate, execution.controller.signal);
                    yield* await this.commit(
                        {
                            type: 'finishCompaction',
                            ...ownership,
                            operationId: randomUUID(),
                            compactionId: planId,
                            attemptId,
                        },
                        runContext
                    );
                }
                view = foldRecords(await this.store.read(sessionId));
                if (!options.compaction && eligibleDeliveries(view).length) continue;
                try {
                    const end = await this.commit(
                        {
                            type: 'end',
                            ...ownership,
                            operationId: randomUUID(),
                            outcome: 'completed',
                        },
                        runContext
                    );
                    ended = true;
                    yield* end;
                    return;
                } catch (error) {
                    if (
                        error instanceof StoreError &&
                        error.code === 'conflict' &&
                        !options.compaction
                    )
                        continue;
                    throw error;
                }
            }
            throw new Error('The run reached its reasoning step limit.');
        } catch (error) {
            if (execution.stopping) {
                const records = await execution.stopping;
                ended = true;
                yield* records;
                return;
            }
            span.setStatus({ code: SpanStatusCode.ERROR, message: 'Agent run failed' });
            if (started) {
                const view = foldRecords(await this.store.read(sessionId));
                if (view.run?.generation === execution.generation) {
                    const attempt = [...view.attempts.values()].find(
                        item => item.outcome === 'running'
                    );
                    if (attempt)
                        await this.commit(
                            {
                                type: 'finishAttempt',
                                ...ownership,
                                operationId: randomUUID(),
                                attemptId: attempt.id,
                                outcome: 'failed',
                                usage: error instanceof ApplicationError ? (error.usage ?? {}) : {},
                                ...(error instanceof ApplicationError
                                    ? { failure: error.failure }
                                    : {}),
                            },
                            runContext
                        );
                    await this.commit(
                        {
                            type: 'end',
                            ...ownership,
                            operationId: randomUUID(),
                            outcome: 'failed',
                            failure:
                                error instanceof ApplicationError
                                    ? error.failure
                                    : { category: 'internal', retry: 'never', outcome: 'unknown' },
                        },
                        runContext
                    );
                }
                ended = true;
            }
            throw error;
        } finally {
            detach();
            try {
                if (started && !ended) {
                    if (execution.stopping) await execution.stopping;
                    else await this.interrupt(sessionId, 'consumer-closed');
                }
            } finally {
                this.active.delete(sessionId);
                span.end();
            }
        }
    }

    /**
     * Check the prepared request before admitting an actual model attempt.
     * @param request The validated request for this operation.
     * @param signal Cancellation for this operation.
     * @returns The estimated input token count.
     */
    private async admit(request: ChatRequest, signal: AbortSignal): Promise<number> {
        if (!isDeepStrictEqual(request.card, validateTextCard(this.model.card)))
            throw new Error('The adapter cannot admit a different model card.');
        const tokens = await abortable(this.model.estimateTokens(request, signal), signal);
        if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error('Invalid token estimate.');
        const card = request.card;
        const contextLimit = this.model.limits
            ? Math.min(
                  card.contextTokens ?? Infinity,
                  this.model.limits.maxInputTokens + this.model.limits.maxOutputTokens
              )
            : card.contextTokens;
        const outputLimit = this.model.limits?.maxOutputTokens ?? card.maxOutputTokens;
        if (contextLimit === null || outputLimit === null)
            throw new Error('Context and output limits must be known.');
        if (tokens + outputLimit > contextLimit)
            throw new ApplicationError({
                category: 'context-limit',
                retry: 'after-change',
                outcome: 'rejected',
            });
        const encoded = new TextEncoder();
        const textInput = card.inputMedia['text/plain'];
        const route = textInput?.routes.find(item => item.delivery === 'text');
        if (!route) throw new Error('Text input route is unavailable.');
        const textBytes =
            encoded.encode(request.system).length +
            request.messages.reduce(
                (total, entry) =>
                    total +
                    entry.blocks.reduce(
                        (size, block) =>
                            size + ('text' in block ? encoded.encode(block.text).length : 0),
                        0
                    ),
                0
            );
        if (textBytes > (route.maxBytes ?? 1048576))
            throw new Error('Text input exceeds its byte budget.');
        if (
            encoded.encode(JSON.stringify(request)).length >
            (card.requestLimits.maxRequestBytes ?? 2097152)
        ) {
            throw new Error('Prepared request exceeds its local byte budget.');
        }
        return tokens;
    }

    /**
     * Persist every emitted chunk and require an explicit terminal provider event.
     * @param request The validated request for this operation.
     * @param attemptId The durable model attempt identity.
     * @param execution The current run ownership and cancellation scope.
     * @param sessionId The target session identity.
     * @param parent The explicit parent tracing context.
     */
    private async *generate(
        request: ChatRequest,
        attemptId: string,
        execution: Execution,
        sessionId: string,
        parent: Context
    ): AsyncGenerator<AgentRecord> {
        const span = this.tracer.startSpan(
            'model.attempt',
            { attributes: { 'model.id': request.card.modelId, 'model.attempt.id': attemptId } },
            parent
        );
        const attemptContext = trace.setSpan(parent, span);
        const signal = execution.controller.signal;
        let iterator: AsyncIterator<ChatEvent> | undefined;
        let completed = false;
        try {
            signal.throwIfAborted();
            iterator = context.with(attemptContext, () =>
                this.model.generate(request, signal)[Symbol.asyncIterator]()
            );
            let index = 0;
            while (true) {
                const next = await abortable(
                    context.with(attemptContext, () =>
                        iterator ? iterator.next() : Promise.reject(new Error('Missing stream.'))
                    ),
                    signal
                );
                if (next.done) throw new Error('Model stream ended without a completion event.');
                const event = chatEventSchema.parse(next.value);
                signal.throwIfAborted();
                const ownership = {
                    sessionId,
                    runId: execution.runId,
                    generation: execution.generation,
                    attemptId,
                    operationId: randomUUID(),
                };
                if (event.type !== 'completed') {
                    yield* await this.commit(
                        {
                            type: 'chunk',
                            ...ownership,
                            index: index++,
                            text:
                                event.type === 'continuation'
                                    ? JSON.stringify(event.item)
                                    : event.text,
                            ...(event.type !== 'text' ? { channel: event.type } : {}),
                        },
                        attemptContext
                    );
                } else {
                    const records = await this.commit(
                        {
                            type: 'finishAttempt',
                            ...ownership,
                            outcome: 'completed',
                            usage: event.usage,
                        },
                        attemptContext
                    );
                    completed = true;
                    yield* records;
                    return;
                }
            }
        } finally {
            if (!completed)
                span.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: 'Model attempt did not complete',
                });
            try {
                if (iterator?.return)
                    await abortable(Promise.resolve(iterator.return()), AbortSignal.timeout(1000));
            } finally {
                span.end();
            }
        }
    }

    /**
     * Correlate commit latency without exposing journal content to tracing exporters.
     * @param command The requested journal transition.
     * @param parent The explicit parent tracing context.
     * @returns The committed record batch.
     */
    private async commit(command: Command, parent: Context): Promise<AgentRecord[]> {
        const span = this.tracer.startSpan(
            'agent.commit',
            { attributes: { 'operation.type': command.type } },
            parent
        );
        try {
            return await this.store.execute(command);
        } catch (error) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: 'Commit failed' });
            throw error;
        } finally {
            span.end();
        }
    }
}
