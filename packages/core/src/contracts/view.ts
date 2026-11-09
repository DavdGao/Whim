import type { FrozenChatCard, ThinkingLevel } from './card.js';
import type { Failure } from './failure.js';
import type {
    Access,
    AgentRecord,
    BodyOf,
    ContextItem,
    EpochContext,
    FileVersion,
    PermissionRule,
    ReviewOutcome,
    ToolDeclaration,
    Usage,
} from './records.js';

export interface HistoryEntry {
    readonly seq: number;
    readonly item: ContextItem;
    /**
     * When it entered the session: for delivered input, when the delivery was accepted (the
     * user's send time); for output and results, when they were committed.
     */
    readonly at: string;
    /** Set for assistant output: whether the attempt completed or was interrupted. */
    readonly status?: 'completed' | 'interrupted';
}

export interface PendingDelivery {
    readonly seq: number;
    readonly deliveryId: string;
    readonly placement: 'next-step' | 'next-run';
    readonly item: ContextItem;
    /** When the delivery was accepted. */
    readonly at: string;
}

export interface Epoch {
    readonly seq: number;
    readonly epochId: string;
    readonly reason: BodyOf<'epoch.started'>['reason'];
    readonly system: string;
    readonly card: FrozenChatCard;
    readonly renderer: number;
    readonly tools: readonly ToolDeclaration[];
    readonly nativeTools: readonly string[];
    readonly providerTools: readonly string[];
    /** Present once the session was compacted. */
    readonly context?: EpochContext;
}

/** A compaction, for display at its place in the conversation. */
export interface Compaction {
    readonly seq: number;
    readonly compactionId: string;
    readonly state: 'running' | 'succeeded' | 'failed';
    /** The summary, once it succeeded. */
    readonly summary?: string;
    /** The first history entry the summary does not cover, once it succeeded. */
    readonly from?: number;
}

/** A tool call of the current step that has no result yet. */
export interface OpenCall {
    readonly callId: string;
    readonly name: string;
    readonly arguments: string;
    readonly state: 'pending' | 'asking' | 'running';
    /** Set while asking: what the call touches. */
    readonly access?: readonly Access[];
    /** Set while asking in auto mode: the review in progress, or the answer that left it to the user. */
    readonly review?: CallReview;
    readonly jobId?: string;
}

export type CallReview =
    | { readonly state: 'running'; readonly cardId: string }
    | {
          readonly state: 'done';
          readonly cardId: string;
          readonly outcome: ReviewOutcome;
          readonly reason: string;
          readonly failure?: Failure;
      };

/** A job that moved to the background and has not ended. */
export interface BackgroundJob {
    readonly jobId: string;
    readonly callId: string;
    readonly name: string;
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
    readonly workspace?: string;
    readonly epoch: Epoch;
    readonly history: readonly HistoryEntry[];
    readonly inbox: ReadonlyMap<string, PendingDelivery>;
    readonly run?: ActiveRun;
    readonly lastRun?: { readonly runId: string; readonly result: BodyOf<'run.ended'>['result'] };
    readonly calls: readonly OpenCall[];
    readonly compactions: readonly Compaction[];
    readonly jobs: readonly BackgroundJob[];
    readonly permissionRules: readonly PermissionRule[];
    readonly usage: Usage;
    /** Usage of the latest attempt that reported input tokens: the context currently in use. */
    readonly lastUsage?: Usage;
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
        ...(first.body.workspace ? { workspace: first.body.workspace } : {}),
        epoch: { seq: 2, ...epochOf(second.body) },
        history: [],
        inbox: new Map(),
        calls: [],
        jobs: [],
        compactions: [],
        permissionRules: [],
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
        tools: body.tools,
        nativeTools: body.nativeTools,
        providerTools: body.providerTools,
        ...(body.context ? { context: body.context } : {}),
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
            if (body.workspace !== undefined) next.workspace = body.workspace;
            return next;
        }
        case 'epoch.started':
            // Only compaction replaces the prefix while a run is active.
            if (run && body.reason !== 'compaction')
                throw new InvalidJournalError('Epoch change during a run.', record.seq);
            return { ...base, epoch: { seq: record.seq, ...epochOf(body) } };
        case 'compaction.started':
            return {
                ...base,
                compactions: [
                    ...view.compactions,
                    { seq: record.seq, compactionId: body.compactionId, state: 'running' },
                ],
            };
        case 'compaction.attempted':
            return { ...base, usage: addUsage(view.usage, body.usage) };
        case 'compaction.finished':
            return {
                ...base,
                ...(body.usage ? { usage: addUsage(view.usage, body.usage) } : {}),
                compactions: view.compactions.map(item =>
                    item.compactionId === body.compactionId
                        ? {
                              ...item,
                              state: body.outcome,
                              ...(body.outcome === 'succeeded' && view.epoch.context
                                  ? {
                                        summary: view.epoch.context.summary,
                                        from: view.epoch.context.from,
                                    }
                                  : {}),
                          }
                        : item
                ),
            };
        case 'delivery.accepted': {
            const inbox = new Map(view.inbox);
            inbox.set(body.deliveryId, {
                seq: record.seq,
                deliveryId: body.deliveryId,
                placement: body.placement,
                item: body.item,
                at: record.createdAt,
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
                history.push({ seq: record.seq, at: pending.at, item: pending.item });
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
            const latest = body.usage.inputTokens !== undefined ? { lastUsage: body.usage } : {};
            if (result.status === 'failed') return { ...base, ...latest, usage, run: rest };
            const calls: OpenCall[] = [];
            for (const block of result.output.blocks)
                if (block.type === 'tool_call') {
                    if (result.status !== 'completed')
                        throw new InvalidJournalError(
                            'An interrupted attempt cannot request tools.',
                            record.seq
                        );
                    calls.push({
                        callId: block.callId,
                        name: block.name,
                        arguments: block.arguments,
                        state: 'pending',
                    });
                }
            const history =
                result.output.blocks.length > 0
                    ? [
                          ...view.history,
                          {
                              seq: record.seq,
                              at: record.createdAt,
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
            return {
                ...base,
                ...latest,
                usage,
                history,
                calls: [...view.calls, ...calls],
                run: rest,
            };
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
            if (view.calls.length)
                throw new InvalidJournalError('Run ended with unanswered tool calls.', record.seq);
            const { run: _run, ...rest } = base;
            return { ...rest, lastRun: { runId: body.runId, result: body.result } };
        }
        case 'permission.requested': {
            requireRun(view, body.runId, record.seq);
            const call = requireCall(view, body.callId, 'pending', record.seq);
            return {
                ...base,
                calls: replaceCall(view, {
                    ...call,
                    state: 'asking',
                    access: body.access,
                    ...(body.reviewer
                        ? { review: { state: 'running', cardId: body.reviewer.cardId } }
                        : {}),
                }),
            };
        }
        case 'permission.reviewed': {
            requireRun(view, body.runId, record.seq);
            const call = requireCall(view, body.callId, 'asking', record.seq);
            if (call.review?.state !== 'running')
                throw new InvalidJournalError('A review needs a running review.', record.seq);
            const usage = addUsage(view.usage, body.usage);
            if (body.outcome !== 'ask' && !body.failure) {
                const { access: _access, review: _review, ...rest } = call;
                return { ...base, usage, calls: replaceCall(view, { ...rest, state: 'pending' }) };
            }
            return {
                ...base,
                usage,
                calls: replaceCall(view, {
                    ...call,
                    review: {
                        state: 'done',
                        cardId: call.review.cardId,
                        outcome: body.outcome,
                        reason: body.reason,
                        ...(body.failure ? { failure: body.failure } : {}),
                    },
                }),
            };
        }
        case 'permission.decided': {
            requireRun(view, body.runId, record.seq);
            const {
                access: _access,
                review: _review,
                ...call
            } = requireCall(view, body.callId, 'asking', record.seq);
            return {
                ...base,
                calls: replaceCall(view, { ...call, state: 'pending' }),
                permissionRules: [...view.permissionRules, ...body.rules],
            };
        }
        case 'tool.started': {
            requireRun(view, body.runId, record.seq);
            const call = requireCall(view, body.callId, 'pending', record.seq);
            return {
                ...base,
                calls: replaceCall(view, { ...call, state: 'running', jobId: body.jobId }),
            };
        }
        case 'tool.usage':
            return { ...base, usage: addUsage(view.usage, body.usage) };
        case 'tool.finished': {
            const result = body.result;
            const call = requireCall(view, result.callId, undefined, record.seq);
            if (result.status === 'background' && !result.jobId)
                throw new InvalidJournalError('A background result needs a job.', record.seq);
            return {
                ...base,
                calls: view.calls.filter(item => item.callId !== call.callId),
                history: [...view.history, { seq: record.seq, at: record.createdAt, item: result }],
                jobs:
                    result.status === 'background' && result.jobId
                        ? [
                              ...view.jobs,
                              { jobId: result.jobId, callId: call.callId, name: call.name },
                          ]
                        : view.jobs,
            };
        }
        case 'job.ended':
            if (!view.jobs.some(job => job.jobId === body.jobId))
                throw new InvalidJournalError('Ended job is not running.', record.seq);
            return { ...base, jobs: view.jobs.filter(job => job.jobId !== body.jobId) };
    }
}

/**
 * Find an open call, optionally in a required state.
 * @param view The current view.
 * @param callId The call.
 * @param state The state it must be in, if any.
 * @param seq The record sequence for error reporting.
 * @returns The call.
 */
function requireCall(
    view: SessionView,
    callId: string,
    state: OpenCall['state'] | undefined,
    seq: number
): OpenCall {
    const call = view.calls.find(item => item.callId === callId);
    if (!call || (state && call.state !== state))
        throw new InvalidJournalError(`Tool call is not ${state ?? 'open'}.`, seq);
    return call;
}

/**
 * Replace one open call, keeping order.
 * @param view The current view.
 * @param call The updated call.
 * @returns The new call list.
 */
function replaceCall(view: SessionView, call: OpenCall): OpenCall[] {
    return view.calls.map(item => (item.callId === call.callId ? call : item));
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

/**
 * The latest version of each file in the model's context: what tool results recorded since the
 * last compaction, which the summary replaced, so the model must read a file again after it.
 * @param view The session view.
 * @returns Versions by absolute path.
 */
export function knownFiles(view: SessionView): Map<string, FileVersion> {
    const from = view.epoch.context?.from ?? 0;
    const files = new Map<string, FileVersion>();
    for (const entry of view.history)
        if (entry.seq >= from && entry.item.type === 'tool_result')
            for (const file of entry.item.files ?? []) files.set(file.path, file);
    return files;
}
