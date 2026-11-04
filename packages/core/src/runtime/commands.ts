import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { frozenChatCardSchema, idSchema, thinkingLevelSchema } from '../contracts/card.js';
import { failureSchema } from '../contracts/failure.js';
import {
    attemptResultSchema,
    contextItemSchema,
    placementSchema,
    runResultSchema,
    usageSchema,
} from '../contracts/records.js';

import type { Body, BodyOf } from '../contracts/records.js';
import type { SessionView } from '../contracts/view.js';

/** Store failures distinguish conflicts, missing targets, invalid input, and corrupt sessions. */
export class StoreError extends Error {
    /**
     * Create a typed store error.
     * @param code The failure kind.
     * @param message Human-readable detail.
     * @param options Standard error options carrying the cause.
     */
    constructor(
        readonly code: 'conflict' | 'not-found' | 'invalid' | 'unreadable' | 'internal',
        message: string,
        options?: ErrorOptions
    ) {
        super(message, options);
        this.name = 'StoreError';
    }
}

const base = { sessionId: idSchema, operationId: idSchema };
const epochInput = {
    epochId: idSchema,
    system: z.string(),
    card: frozenChatCardSchema,
    renderer: z.number().int().positive(),
};

export const commandSchema = z.discriminatedUnion('type', [
    z.strictObject({
        ...base,
        type: z.literal('create'),
        title: z.string().max(200),
        credentialId: idSchema,
        thinking: thinkingLevelSchema.optional(),
        epoch: z.strictObject(epochInput),
    }),
    z.strictObject({
        ...base,
        type: z.literal('send'),
        deliveryId: idSchema,
        placement: placementSchema,
        item: contextItemSchema,
    }),
    z.strictObject({ ...base, type: z.literal('withdraw'), deliveryId: idSchema }),
    z.strictObject({
        ...base,
        type: z.literal('update'),
        title: z.string().max(200).optional(),
        credentialId: idSchema.optional(),
        thinking: thinkingLevelSchema.nullable().optional(),
    }),
    z.strictObject({ ...base, type: z.literal('switch-model'), epoch: z.strictObject(epochInput) }),
    z.strictObject({
        ...base,
        type: z.literal('start-run'),
        runId: idSchema,
        trigger: z.enum(['user', 'continue', 'restart']),
    }),
    z.strictObject({ ...base, type: z.literal('prepare-step'), runId: idSchema, stepId: idSchema }),
    z.strictObject({
        ...base,
        type: z.literal('start-attempt'),
        runId: idSchema,
        stepId: idSchema,
        attemptId: idSchema,
        number: z.number().int().positive(),
    }),
    z.strictObject({
        ...base,
        type: z.literal('finish-attempt'),
        attemptId: idSchema,
        usage: usageSchema,
        result: attemptResultSchema,
    }),
    z.strictObject({
        ...base,
        type: z.literal('schedule-retry'),
        runId: idSchema,
        stepId: idSchema,
        number: z.number().int().positive(),
        at: z.iso.datetime(),
        failure: failureSchema,
    }),
    z.strictObject({
        ...base,
        type: z.literal('interrupt'),
        runId: idSchema,
        reason: z.enum(['user', 'shutdown', 'plugin-removed']),
        observedAt: z.iso.datetime(),
    }),
    z.strictObject({
        ...base,
        type: z.literal('end-run'),
        runId: idSchema,
        result: runResultSchema,
    }),
    z.strictObject({
        ...base,
        type: z.literal('recover'),
        reason: z.enum(['shutdown', 'crash']),
        observedAt: z.iso.datetime(),
    }),
]);
export type Command = z.infer<typeof commandSchema>;

/**
 * Decide which facts a command produces against the current view. Runs inside the write
 * transaction, so validation and append are atomic.
 * @param view The session view, or null when the session does not exist.
 * @param command The validated command.
 * @returns Record bodies to append, possibly none.
 */
export function decide(view: SessionView | null, command: Command): Body[] {
    if (command.type === 'create') {
        if (view) throw new StoreError('conflict', 'Session already exists.');
        return [
            {
                type: 'session.created',
                title: command.title,
                credentialId: command.credentialId,
                ...(command.thinking ? { thinking: command.thinking } : {}),
            },
            { type: 'epoch.started', reason: 'initial', ...command.epoch },
        ];
    }
    if (!view) throw new StoreError('not-found', 'Session not found.');
    const run = view.run;
    switch (command.type) {
        case 'send':
            if (view.inbox.has(command.deliveryId))
                throw new StoreError('conflict', 'Delivery already accepted.');
            return [
                {
                    type: 'delivery.accepted',
                    deliveryId: command.deliveryId,
                    placement: command.placement,
                    item: command.item,
                },
            ];
        case 'withdraw':
            if (!view.inbox.has(command.deliveryId))
                throw new StoreError('conflict', 'The message is no longer pending.');
            return [{ type: 'delivery.withdrawn', deliveryId: command.deliveryId }];
        case 'update': {
            const body: BodyOf<'session.updated'> = { type: 'session.updated' };
            if (command.title !== undefined) body.title = command.title;
            if (command.credentialId !== undefined) body.credentialId = command.credentialId;
            if (command.thinking !== undefined) body.thinking = command.thinking;
            return [body];
        }
        case 'switch-model':
            if (run) throw new StoreError('conflict', 'The model cannot change during a run.');
            return [{ type: 'epoch.started', reason: 'model-switch', ...command.epoch }];
        case 'start-run':
            if (run) return [];
            return [{ type: 'run.started', runId: command.runId, trigger: command.trigger }];
        case 'prepare-step': {
            requireActive(view, command.runId);
            if (run?.interrupt) throw new StoreError('conflict', 'The run was interrupted.');
            const firstStep = run?.stepId === undefined;
            const consumed = [...view.inbox.values()]
                .filter(pending => firstStep || pending.placement === 'next-step')
                .sort((left, right) => left.seq - right.seq)
                .map(pending => pending.deliveryId);
            if (!firstStep && consumed.length === 0) return [];
            return [
                { type: 'step.prepared', runId: command.runId, stepId: command.stepId, consumed },
            ];
        }
        case 'start-attempt':
            requireActive(view, command.runId);
            if (run?.interrupt) throw new StoreError('conflict', 'The run was interrupted.');
            if (run?.stepId !== command.stepId || run.attempt)
                throw new StoreError('conflict', 'The step cannot start an attempt.');
            return [
                {
                    type: 'attempt.started',
                    runId: command.runId,
                    stepId: command.stepId,
                    attemptId: command.attemptId,
                    number: command.number,
                },
            ];
        case 'finish-attempt':
            if (run?.attempt?.attemptId !== command.attemptId)
                throw new StoreError('conflict', 'The attempt is not active.');
            return [
                {
                    type: 'attempt.finished',
                    attemptId: command.attemptId,
                    usage: command.usage,
                    result: command.result,
                },
            ];
        case 'schedule-retry':
            requireActive(view, command.runId);
            if (run?.interrupt) throw new StoreError('conflict', 'The run was interrupted.');
            return [
                {
                    type: 'retry.scheduled',
                    runId: command.runId,
                    stepId: command.stepId,
                    number: command.number,
                    at: command.at,
                    failure: command.failure,
                },
            ];
        case 'interrupt': {
            if (run?.runId !== command.runId || run.interrupt) return [];
            const requested: Body = {
                type: 'interrupt.requested',
                runId: command.runId,
                reason: command.reason,
            };
            // Shutdown is not the user's doing; the restart notice is delivered by recovery.
            if (command.reason === 'shutdown') return [requested];
            const reason = command.reason;
            return [
                requested,
                {
                    type: 'delivery.accepted',
                    deliveryId: randomUUID(),
                    placement: 'next-run',
                    item: {
                        type: 'notice',
                        id: randomUUID(),
                        kind: 'interrupted',
                        origin: { type: 'core', service: 'agent' },
                        observedAt: command.observedAt,
                        payload: { runId: command.runId, reason },
                    },
                },
            ];
        }
        case 'end-run':
            requireActive(view, command.runId);
            if (run?.attempt) throw new StoreError('conflict', 'An attempt is still open.');
            return [{ type: 'run.ended', runId: command.runId, result: command.result }];
        case 'recover': {
            if (!run) {
                const last = view.lastRun;
                if (!last || !needsRestartNotice(view)) return [];
                return [restartedNotice(last.runId, command.observedAt)];
            }
            const facts: Body[] = [];
            if (run.attempt)
                facts.push({
                    type: 'attempt.finished',
                    attemptId: run.attempt.attemptId,
                    usage: {},
                    result: {
                        status: 'interrupted',
                        output: { messageId: randomUUID(), blocks: [] },
                    },
                });
            const reason = run.interrupt ?? command.reason;
            facts.push(
                {
                    type: 'run.ended',
                    runId: run.runId,
                    result: { outcome: 'interrupted', reason },
                },
                restartedNotice(run.runId, command.observedAt)
            );
            return facts;
        }
    }
}

/**
 * Whether the last run ended by shutdown or crash and the agent was not told yet.
 * @param view The session view.
 * @returns True when a restarted notice is owed.
 */
export function needsRestartNotice(view: SessionView): boolean {
    const last = view.lastRun;
    if (view.run || !last || last.result.outcome !== 'interrupted') return false;
    if (last.result.reason !== 'shutdown' && last.result.reason !== 'crash') return false;
    return ![...view.inbox.values()].some(
        pending =>
            pending.item.type === 'notice' &&
            pending.item.kind === 'restarted' &&
            pending.item.payload.runId === last.runId
    );
}

/**
 * Build the delivery that tells the agent its run was cut off by a restart.
 * @param runId The interrupted run.
 * @param observedAt When recovery observed it.
 * @returns The delivery fact.
 */
function restartedNotice(runId: string, observedAt: string): Body {
    return {
        type: 'delivery.accepted',
        deliveryId: randomUUID(),
        placement: 'next-run',
        item: {
            type: 'notice',
            id: randomUUID(),
            kind: 'restarted',
            origin: { type: 'core', service: 'agent' },
            observedAt,
            payload: { runId },
        },
    };
}

/**
 * Reject commands from a stale or absent run.
 * @param view The session view.
 * @param runId The run the command claims.
 */
function requireActive(view: SessionView, runId: string): void {
    if (view.run?.runId !== runId) throw new StoreError('conflict', 'The run is not active.');
}
