import type { FrozenChatCard, ThinkingLevel } from './card.js';
import type { Failure } from './failure.js';
import type { AgentRecord, BodyOf, ContextItem, Usage } from './records.js';

export interface HistoryEntry {
    readonly seq: number;
    readonly item: ContextItem;
    /** Set for assistant output: whether the attempt completed or was interrupted. */
    readonly status?: 'completed' | 'interrupted';
}

export interface PendingDelivery {
    readonly seq: number;
    readonly deliveryId: string;
    readonly placement: 'next-step' | 'next-run';
    readonly item: ContextItem;
}

export interface Epoch {
    readonly seq: number;
    readonly epochId: string;
    readonly reason: BodyOf<'epoch.started'>['reason'];
    readonly system: string;
    readonly card: FrozenChatCard;
    readonly renderer: number;
}

export interface ActiveRun {
    readonly runId: string;
    readonly trigger: BodyOf<'run.started'>['trigger'];
    readonly stepId?: string;
    readonly attempt?: {
        readonly attemptId: string;
        readonly number: number;
        readonly stepId: string;
    };
    readonly retry?: { readonly number: number; readonly at: string; readonly failure: Failure };
    readonly interrupt?: BodyOf<'interrupt.requested'>['reason'];
}

export interface SessionView {
    readonly sessionId: string;
    readonly head: number;
    readonly title: string;
    readonly credentialId: string;
    readonly thinking?: ThinkingLevel;
    readonly epoch: Epoch;
    readonly history: readonly HistoryEntry[];
    readonly inbox: ReadonlyMap<string, PendingDelivery>;
    readonly run?: ActiveRun;
    readonly lastRun?: { readonly runId: string; readonly result: BodyOf<'run.ended'>['result'] };
    readonly usage: Usage;
    readonly createdAt: string;
    readonly updatedAt: string;
}

/** Raised when records do not form a valid session; the session is reported unreadable. */
export class InvalidJournalError extends Error {
    /**
     * Describe the violated invariant.
     * @param message What is inconsistent.
     * @param seq The offending record sequence.
     */
    constructor(message: string, seq?: number) {
        super(seq === undefined ? message : `${message} (seq ${seq})`);
        this.name = 'InvalidJournalError';
    }
}

/**
 * Sum reported usage, keeping fields unknown until some attempt reports them.
 * @param total The running total.
 * @param next One attempt's usage.
 * @returns The combined usage.
 */
function addUsage(total: Usage, next: Usage): Usage {
    const result: Record<string, number> = { ...total };
    for (const [key, value] of Object.entries(next)) {
        if (typeof value === 'number') result[key] = (result[key] ?? 0) + value;
    }
    return result;
}

/**
 * Fold an ordered session journal into its view.
 * @param records Records of one session in sequence order, starting at seq 1.
 * @returns The session view.
 */
export function foldSession(records: readonly AgentRecord[]): SessionView {
    const [first, second, ...rest] = records;
    if (first?.body.type !== 'session.created' || first.seq !== 1)
        throw new InvalidJournalError('A session must start with session.created.');
    if (second?.body.type !== 'epoch.started' || second.seq !== 2)
        throw new InvalidJournalError('A session must have an initial epoch.');
    let view: SessionView = {
        sessionId: first.sessionId,
        head: 2,
        title: first.body.title,
        credentialId: first.body.credentialId,
        ...(first.body.thinking ? { thinking: first.body.thinking } : {}),
        epoch: { seq: 2, ...epochOf(second.body) },
        history: [],
        inbox: new Map(),
        usage: {},
        createdAt: first.createdAt,
        updatedAt: second.createdAt,
    };
    for (const record of rest) view = applyRecord(view, record);
    return view;
}

/**
 * Extract epoch fields from its record body.
 * @param body The epoch record body.
 * @returns The epoch without its sequence.
 */
function epochOf(body: BodyOf<'epoch.started'>): Omit<Epoch, 'seq'> {
    return {
        epochId: body.epochId,
        reason: body.reason,
        system: body.system,
        card: body.card,
        renderer: body.renderer,
    };
}

/**
 * Apply one record to a view, validating ordering invariants.
 * @param view The current view.
 * @param record The next record of the same session.
 * @returns The new view.
 */
export function applyRecord(view: SessionView, record: AgentRecord): SessionView {
    if (record.sessionId !== view.sessionId || record.seq !== view.head + 1)
        throw new InvalidJournalError('Record out of order.', record.seq);
    const base = { ...view, head: record.seq, updatedAt: record.createdAt };
    const body = record.body;
    const run = view.run;
    switch (body.type) {
        case 'session.created':
            throw new InvalidJournalError('Duplicate session.created.', record.seq);
        case 'session.updated': {
            const next: { -readonly [K in keyof SessionView]: SessionView[K] } = { ...base };
            if (body.title !== undefined) next.title = body.title;
            if (body.credentialId !== undefined) next.credentialId = body.credentialId;
            if (body.thinking === null) delete next.thinking;
            else if (body.thinking !== undefined) next.thinking = body.thinking;
            return next;
        }
        case 'epoch.started':
            if (run) throw new InvalidJournalError('Epoch change during a run.', record.seq);
            return { ...base, epoch: { seq: record.seq, ...epochOf(body) } };
        case 'delivery.accepted': {
            const inbox = new Map(view.inbox);
            inbox.set(body.deliveryId, {
                seq: record.seq,
                deliveryId: body.deliveryId,
                placement: body.placement,
                item: body.item,
            });
            return { ...base, inbox };
        }
        case 'delivery.withdrawn': {
            if (!view.inbox.has(body.deliveryId))
                throw new InvalidJournalError('Withdrawn delivery is not pending.', record.seq);
            const inbox = new Map(view.inbox);
            inbox.delete(body.deliveryId);
            return { ...base, inbox };
        }
        case 'run.started':
            if (run) throw new InvalidJournalError('A run is already active.', record.seq);
            return { ...base, run: { runId: body.runId, trigger: body.trigger } };
        case 'step.prepared': {
            const active = requireRun(view, body.runId, record.seq);
            const inbox = new Map(view.inbox);
            const history = [...view.history];
            for (const id of body.consumed) {
                const pending = inbox.get(id);
                if (!pending)
                    throw new InvalidJournalError('Consumed delivery is not pending.', record.seq);
                inbox.delete(id);
                history.push({ seq: record.seq, item: pending.item });
            }
            return {
                ...base,
                inbox,
                history,
                run: { runId: active.runId, trigger: active.trigger, stepId: body.stepId },
            };
        }
        case 'attempt.started': {
            const active = requireRun(view, body.runId, record.seq);
            if (active.stepId !== body.stepId)
                throw new InvalidJournalError('Attempt for an unknown step.', record.seq);
            const { retry: _retry, ...rest } = active;
            return {
                ...base,
                run: {
                    ...rest,
                    attempt: {
                        attemptId: body.attemptId,
                        number: body.number,
                        stepId: body.stepId,
                    },
                },
            };
        }
        case 'attempt.finished': {
            if (!run?.attempt || run.attempt.attemptId !== body.attemptId)
                throw new InvalidJournalError('Finished attempt is not active.', record.seq);
            const { attempt: _attempt, ...rest } = run;
            const usage = addUsage(view.usage, body.usage);
            const result = body.result;
            if (result.status === 'failed') return { ...base, usage, run: rest };
            const history =
                result.output.blocks.length > 0
                    ? [
                          ...view.history,
                          {
                              seq: record.seq,
                              status: result.status,
                              item: {
                                  type: 'message' as const,
                                  id: result.output.messageId,
                                  role: 'assistant' as const,
                                  blocks: result.output.blocks,
                              },
                          },
                      ]
                    : view.history;
            return { ...base, usage, history, run: rest };
        }
        case 'retry.scheduled': {
            const active = requireRun(view, body.runId, record.seq);
            return {
                ...base,
                run: {
                    ...active,
                    retry: { number: body.number, at: body.at, failure: body.failure },
                },
            };
        }
        case 'interrupt.requested': {
            const active = requireRun(view, body.runId, record.seq);
            return { ...base, run: { ...active, interrupt: body.reason } };
        }
        case 'run.ended': {
            const active = requireRun(view, body.runId, record.seq);
            if (active.attempt)
                throw new InvalidJournalError('Run ended with an open attempt.', record.seq);
            const { run: _run, ...rest } = base;
            return { ...rest, lastRun: { runId: body.runId, result: body.result } };
        }
    }
}

/**
 * Require that the record targets the active run.
 * @param view The current view.
 * @param runId The run the record names.
 * @param seq The record sequence for error reporting.
 * @returns The active run.
 */
function requireRun(view: SessionView, runId: string, seq: number): ActiveRun {
    if (view.run?.runId !== runId) throw new InvalidJournalError('Run is not active.', seq);
    return view.run;
}
