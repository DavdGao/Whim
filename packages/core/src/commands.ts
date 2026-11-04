import { validateTextCard } from '@whimkit/models';

import { eligibleDeliveries } from './view.js';

import type { Command, Fact } from './records.js';
import type { SessionView } from './view.js';

/** A rejected transition never appends a partial record batch. */
export class StoreError extends Error {
    /**
     * Preserve a machine-readable rejection code across the worker boundary.
     * @param code The stable rejection category.
     * @param message A content-free explanation of the rejection.
     */
    constructor(
        public readonly code: 'conflict' | 'stale-run' | 'not-found' | 'invalid',
        message: string
    ) {
        super(message);
        this.name = 'StoreError';
    }
}

/**
 * Validate one business transition against the latest transactional session view.
 * @param view The latest replayed session state.
 * @param command The requested journal transition.
 * @returns The complete fact batch to append atomically.
 */
export function decide(view: SessionView | null, command: Command): Fact[] {
    if (command.type === 'create') {
        if (view) throw new StoreError('conflict', 'Session already exists.');
        validateTextCard(command.epoch.card);
        return [{ type: 'session.created', epoch: command.epoch }];
    }
    if (!view) throw new StoreError('not-found', 'Session not found.');
    if (
        'generation' in command &&
        command.type !== 'start' &&
        (view.run?.generation !== command.generation || view.run.id !== command.runId)
    ) {
        throw new StoreError('stale-run', 'The run no longer owns this session.');
    }
    const running = [...view.attempts.values()].find(attempt => attempt.outcome === 'running');
    switch (command.type) {
        case 'enqueue': {
            if (
                view.inbox.has(command.delivery.id) ||
                [...view.inbox.values()].some(
                    item => item.delivery.entry.id === command.delivery.entry.id
                ) ||
                view.messages.some(message => message.id === command.delivery.entry.id)
            ) {
                throw new StoreError('conflict', 'Delivery or entry ID already exists.');
            }
            const { entry, source } = command.delivery;
            if (entry.role !== 'user' || entry.origin !== (source === 'user' ? 'user' : 'host')) {
                throw new StoreError('invalid', 'Inbox origin does not match its source.');
            }
            return [
                ...(source === 'user' && view.held ? [{ type: 'session.resumed' } as const] : []),
                { type: 'inbox.accepted', delivery: command.delivery },
            ];
        }
        case 'start':
            if (
                view.run ||
                view.held ||
                view.runs.has(command.runId) ||
                [...view.runs.values()].includes(command.generation)
            )
                throw new StoreError('conflict', 'Session is running or held.');
            return [{ type: 'run.started', runId: command.runId, generation: command.generation }];
        case 'prepare': {
            const eligible = eligibleDeliveries(view)
                .slice(0, command.deliveryIds.length)
                .map(item => item.id);
            if (
                running ||
                view.compaction ||
                view.contextVersion !== command.expectedContextVersion ||
                (command.deliveryIds.length === 0 && view.messages.length === 0) ||
                JSON.stringify(eligible) !== JSON.stringify(command.deliveryIds) ||
                view.plans.has(command.planId) ||
                [...view.plans].some(
                    ([id, plan]) =>
                        plan.runId === command.runId &&
                        ![...view.attempts.values()].some(attempt => attempt.planId === id)
                )
            ) {
                throw new StoreError('conflict', 'Context or pending reasoning plan changed.');
            }
            return [
                {
                    type: 'reasoning.prepared',
                    runId: command.runId,
                    planId: command.planId,
                    deliveryIds: command.deliveryIds,
                    estimatedTokens: command.estimatedTokens,
                },
            ];
        }
        case 'attempt': {
            const plan = view.plans.get(command.planId);
            if (
                running ||
                !plan ||
                plan.runId !== command.runId ||
                plan.request.purpose !== command.purpose ||
                [...view.attempts.values()].some(
                    attempt =>
                        attempt.planId === command.planId ||
                        attempt.id === command.attemptId ||
                        attempt.messageId === command.messageId
                ) ||
                view.messages.some(message => message.id === command.messageId) ||
                [...view.inbox.values()].some(item => item.delivery.entry.id === command.messageId)
            ) {
                throw new StoreError('conflict', 'Attempt does not match an unused frozen plan.');
            }
            return [
                {
                    type: 'attempt.started',
                    attemptId: command.attemptId,
                    planId: command.planId,
                    messageId: command.messageId,
                    purpose: command.purpose,
                },
            ];
        }
        case 'chunk':
            if (
                !running ||
                running.id !== command.attemptId ||
                command.index !== running.outputCount ||
                running.outputSize + command.text.length > 1048576
            ) {
                throw new StoreError('conflict', 'Invalid, late, or oversized stream chunk.');
            }
            return [
                {
                    type: 'output.chunk',
                    attemptId: command.attemptId,
                    index: command.index,
                    text: command.text,
                    ...(command.channel ? { channel: command.channel } : {}),
                },
            ];
        case 'finishAttempt':
            if (!running || running.id !== command.attemptId)
                throw new StoreError('conflict', 'Attempt is not running.');
            return [
                {
                    type: 'attempt.finished',
                    attemptId: command.attemptId,
                    outcome: command.outcome,
                    usage: command.usage,
                    ...(command.failure ? { failure: command.failure } : {}),
                    reason: command.outcome === 'failed' ? 'model-error' : null,
                },
            ];
        case 'end':
            if (
                running ||
                (command.outcome === 'completed' &&
                    eligibleDeliveries(view).length &&
                    ![...view.plans.values()].some(
                        plan =>
                            plan.runId === command.runId && plan.request.purpose === 'compaction'
                    ))
            ) {
                throw new StoreError('conflict', 'Session still has work.');
            }
            return [
                {
                    type: 'run.ended',
                    runId: command.runId,
                    outcome: command.outcome,
                    ...(command.failure ? { failure: command.failure } : {}),
                },
            ];
        case 'interrupt':
        case 'recover': {
            if (!view.run) return [];
            const reason = command.type === 'recover' ? 'crash' : command.reason;
            return [
                ...(running
                    ? [
                          {
                              type: 'attempt.finished',
                              attemptId: running.id,
                              outcome: 'interrupted',
                              reason,
                              usage: {},
                          } as const,
                      ]
                    : []),
                { type: 'run.interrupted', runId: view.run.id, reason },
            ];
        }
        case 'resume':
            return view.held ? [{ type: 'session.resumed' }] : [];
        case 'task': {
            if ((view.tasks.get(command.task.id)?.revision ?? null) !== command.expectedRevision) {
                throw new StoreError('conflict', 'Task revision changed.');
            }
            return [
                { type: 'task.updated', task: command.task },
                {
                    type: 'inbox.accepted',
                    delivery: {
                        id: `${command.operationId}:task`,
                        source: 'runtime',
                        placement: 'next-reasoning',
                        entry: {
                            id: `${command.operationId}:entry`,
                            role: 'user',
                            origin: 'host',
                            blocks: [
                                {
                                    type: 'text',
                                    text: `<system-notification>Task changed: ${JSON.stringify(command.task).replaceAll('<', '\\u003c')}</system-notification>`,
                                },
                            ],
                        },
                    },
                },
            ];
        }
        case 'compact': {
            const suffix = view.messages
                .slice(view.messages.length - command.retainedIds.length)
                .map(message => message.id);
            if (
                running ||
                view.compaction ||
                view.contextVersion !== command.expectedContextVersion ||
                view.plans.has(command.compactionId) ||
                command.epoch.id === view.epoch.id ||
                JSON.stringify(suffix) !== JSON.stringify(command.retainedIds) ||
                view.protectedIds.some(id => !command.retainedIds.includes(id))
            ) {
                throw new StoreError(
                    'conflict',
                    'Compaction must preserve the current tail and interrupted output.'
                );
            }
            validateTextCard(command.epoch.card);
            return [
                {
                    type: 'compaction.started',
                    compactionId: command.compactionId,
                    epoch: command.epoch,
                    retainedIds: command.retainedIds,
                },
            ];
        }
        case 'finishCompaction': {
            const attempt = view.attempts.get(command.attemptId);
            if (
                view.compaction?.id !== command.compactionId ||
                attempt?.planId !== command.compactionId ||
                attempt.outcome !== 'completed' ||
                !attempt.chunks.join('').trim()
            ) {
                throw new StoreError('conflict', 'Compaction has no completed summary.');
            }
            return [
                {
                    type: 'compaction.finished',
                    compactionId: command.compactionId,
                    attemptId: command.attemptId,
                },
            ];
        }
    }
}
