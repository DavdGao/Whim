import { ArchiveIcon, CheckIcon, CopyIcon, MessageSquareIcon, XIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { ActionButton } from '../../components/action-button';
import { Markdown } from '../../components/markdown';
import { call } from '../../lib/client';
import { useT } from '../../lib/i18n';

import { formatDuration } from './duration';
import { FailureNotice } from './failure-notice';
import { mathPlugin, normalizeMath } from './math';
import { MediaView } from './media-view';
import { PullToLoad } from './pull-to-load';
import { NativeToolView, ToolCallView } from './tool-call';

import type { Draft } from './use-session';
import type {
    Block,
    Compaction,
    Failure,
    HistoryEntry,
    MediaBlock,
    Notice,
    SessionView,
    ToolResult,
} from '@whimkit/core/contracts';
import type { ReactNode } from 'react';

import {
    Conversation,
    ConversationContent,
    ConversationEmptyState,
    ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import {
    Message,
    MessageAction,
    MessageActions,
    MessageContent,
} from '@/components/ai-elements/message';
import { Badge } from '@/components/ui/badge';
import {
    Trace,
    TraceCollapsible,
    TraceCollapsibleContent,
    TraceCollapsibleTrigger,
    TraceIcon,
    TraceLine,
    TraceTitle,
} from '@/components/ui/trace';

/**
 * Join the text of blocks of one type.
 * @param blocks Message blocks.
 * @param type Which block type.
 * @returns The joined text.
 */
function textOf(blocks: readonly Block[], type: 'text' | 'reasoning'): string {
    return blocks
        .filter(block => block.type === type)
        .map(block => ('text' in block ? block.text : ''))
        .join('');
}

/**
 * The recorded reasoning duration of a message.
 * @param blocks Message blocks.
 * @returns The duration prop, or nothing when unrecorded.
 */
function reasoningTime(blocks: readonly Block[]): { reasoningMs?: number } {
    const block = blocks.find(item => item.type === 'reasoning');
    return block?.type === 'reasoning' && block.durationMs !== undefined
        ? { reasoningMs: block.durationMs }
        : {};
}

/**
 * The media blocks of a message.
 * @param blocks Message blocks.
 * @returns Its attachments.
 */
function mediaOf(blocks: readonly Block[]): MediaBlock[] {
    return blocks.filter(block => block.type === 'media');
}

/**
 * The footer under a finished turn: copy its answers and how long it took. Secondary to the
 * answer, so it is muted and small.
 * @param props Footer props.
 * @param props.text Markdown of the turn's answers.
 * @param props.ms How long the turn took, when known.
 * @returns The footer.
 */
function TurnFooter({ text, ms }: { text: string; ms?: number }) {
    const { t } = useT();
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(false), 1500);
        return () => clearTimeout(timer);
    }, [copied]);
    return (
        <MessageActions className="text-muted-foreground -ml-1.5 text-xs">
            {text && (
                <MessageAction
                    size="icon-xs"
                    className="text-muted-foreground"
                    tooltip={copied ? t('common.copied') : t('common.copy')}
                    onClick={() =>
                        void navigator.clipboard.writeText(text).then(
                            () => setCopied(true),
                            () => toast.error(t('error.generic'))
                        )
                    }
                >
                    {copied ? (
                        <CheckIcon className="size-3.5" />
                    ) : (
                        <CopyIcon className="size-3.5" />
                    )}
                </MessageAction>
            )}
            {ms !== undefined && (
                <span className="px-1">
                    {t('chat.turnTime', { duration: formatDuration(ms, t) })}
                </span>
            )}
        </MessageActions>
    );
}

/**
 * Whether a node list renders anything.
 * @param node Children, possibly an array with nulls.
 * @returns True when something is present.
 */
function hasContent(node: ReactNode): boolean {
    return Array.isArray(node)
        ? node.some(hasContent)
        : node !== null && node !== undefined && node !== false;
}

/**
 * The model's thinking as a trace line: "Thinking" while it streams, then "Thought" with its
 * duration. It opens while thinking and closes after; the user's choice wins.
 * @param props Line props.
 * @param props.text The reasoning text.
 * @param props.running Whether the model is still thinking.
 * @param props.ms Recorded duration.
 * @returns The line.
 */
function ReasoningLine({ text, running, ms }: { text: string; running: boolean; ms?: number }) {
    const { t } = useT();
    const [open, setOpen] = useState<boolean>();
    return (
        <TraceCollapsible open={open ?? running} onOpenChange={setOpen}>
            <TraceCollapsibleTrigger>
                <TraceLine status={running ? 'running' : undefined}>
                    <TraceTitle>
                        {running
                            ? t('chat.thinkingNow')
                            : ms === undefined
                              ? t('chat.thought')
                              : t('chat.thoughtFor', { duration: formatDuration(ms, t) })}
                    </TraceTitle>
                </TraceLine>
            </TraceCollapsibleTrigger>
            <TraceCollapsibleContent>
                <Markdown className="text-sm" plugins={{ math: mathPlugin }}>
                    {normalizeMath(text)}
                </Markdown>
            </TraceCollapsibleContent>
        </TraceCollapsible>
    );
}

/**
 * A user message, sent or queued.
 * @param props Message parts.
 * @param props.text Visible text.
 * @param props.media Files attached to the message, with the session that stores them.
 * @param props.media.sessionId Session that stores the files.
 * @param props.media.blocks The attachments.
 * @param props.badge Optional status badge.
 * @param props.onRemove Optional remove action.
 * @returns The message.
 */
function UserBubble({
    text,
    media,
    badge,
    onRemove,
}: {
    text: string;
    media: { sessionId: string; blocks: readonly MediaBlock[] };
    badge?: string;
    onRemove?: () => Promise<unknown>;
}) {
    const { t } = useT();
    return (
        <>
            {media.blocks.length > 0 && (
                <MediaView sessionId={media.sessionId} media={media.blocks} />
            )}
            <Message from="user">
                <MessageContent>
                    {text && <p className="wrap-anywhere whitespace-pre-wrap">{text}</p>}
                    {(badge || onRemove) && (
                        <div className="flex items-center gap-2">
                            {badge && <Badge variant="secondary">{badge}</Badge>}
                            {onRemove && (
                                <ActionButton
                                    size="xs"
                                    variant="ghost"
                                    icon={<XIcon />}
                                    action={onRemove}
                                >
                                    {t('chat.withdraw')}
                                </ActionButton>
                            )}
                        </div>
                    )}
                </MessageContent>
            </Message>
        </>
    );
}

/**
 * One model output inside a turn: its thinking and provider-run searches, the answer text,
 * then the tool calls it made.
 * @param props Output parts.
 * @param props.text Answer text.
 * @param props.reasoning Reasoning text.
 * @param props.reasoningMs How long the model reasoned, when recorded.
 * @param props.streaming Whether it is still streaming.
 * @param props.interrupted Whether the user stopped it.
 * @param props.leading Provider-executed calls, which happen before the answer text.
 * @param props.children Tool calls shown after the text.
 * @returns The output.
 */
function AssistantOutput({
    text,
    reasoning,
    reasoningMs,
    streaming,
    interrupted,
    leading,
    children,
}: {
    text: string;
    reasoning: string;
    reasoningMs?: number;
    streaming?: boolean;
    interrupted?: boolean;
    leading?: ReactNode;
    children?: ReactNode;
}) {
    const { t } = useT();
    return (
        <>
            {reasoning || hasContent(leading) ? (
                <Trace>
                    {reasoning ? (
                        <ReasoningLine
                            text={reasoning}
                            running={Boolean(streaming && !text)}
                            {...(reasoningMs !== undefined ? { ms: reasoningMs } : {})}
                        />
                    ) : null}
                    {leading}
                </Trace>
            ) : null}
            {text && <Markdown plugins={{ math: mathPlugin }}>{normalizeMath(text)}</Markdown>}
            {hasContent(children) ? <Trace>{children}</Trace> : null}
            {interrupted && (
                <div>
                    <Badge variant="secondary">{t('chat.interrupted')}</Badge>
                </div>
            )}
        </>
    );
}

/**
 * Everything the agent did between two user messages, as one message with one footer.
 * Answers take the full width so short text above a code block does not narrow it.
 * @param props Turn props.
 * @param props.children The turn's outputs, tool calls, and notices.
 * @param props.footer The footer, once the turn is over.
 * @returns The turn.
 */
function Turn({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
    return (
        <Message from="assistant" className="max-w-full">
            {/* Visible overflow lets inset cards widen past the text column (design §11.3). */}
            <MessageContent className="w-full overflow-visible">
                {children}
                {footer}
            </MessageContent>
        </Message>
    );
}

/** A user message, or the entries the agent produced before the next one. */
type Row =
    | { readonly kind: 'user'; readonly entry: HistoryEntry }
    | {
          readonly kind: 'turn';
          readonly entries: readonly HistoryEntry[];
          /** When the user message that started it was committed, if it is loaded. */
          readonly since?: string;
      };

/**
 * Split history into user messages and the agent turns between them.
 * @param history Loaded history, oldest first.
 * @returns The rows.
 */
function rowsOf(history: readonly HistoryEntry[]): Row[] {
    const rows: Row[] = [];
    let since: string | undefined;
    for (const entry of history) {
        if (entry.item.type === 'message' && entry.item.role === 'user') {
            rows.push({ kind: 'user', entry });
            since = entry.at;
            continue;
        }
        const last = rows.at(-1);
        if (last?.kind === 'turn')
            rows[rows.length - 1] = { ...last, entries: [...last.entries, entry] };
        else rows.push({ kind: 'turn', entries: [entry], ...(since ? { since } : {}) });
    }
    return rows;
}

/**
 * The answer text of a turn, for copying.
 * @param entries The turn's entries.
 * @returns Its answers joined as Markdown paragraphs.
 */
function turnText(entries: readonly HistoryEntry[]): string {
    return entries
        .map(entry => (entry.item.type === 'message' ? textOf(entry.item.blocks, 'text') : ''))
        .filter(Boolean)
        .join('\n\n');
}

/**
 * Where the conversation was compacted: running, the summary to expand, or a failure.
 * @param props Line props.
 * @param props.compaction The compaction.
 * @returns The line.
 */
function CompactionLine({ compaction }: { compaction: Compaction }) {
    const { t } = useT();
    if (compaction.state !== 'succeeded')
        return (
            <Trace>
                <TraceLine status={compaction.state === 'running' ? 'running' : 'error'}>
                    <TraceIcon>
                        <ArchiveIcon />
                    </TraceIcon>
                    <TraceTitle>
                        {compaction.state === 'running'
                            ? t('chat.compacting')
                            : t('chat.compactFailed')}
                    </TraceTitle>
                </TraceLine>
            </Trace>
        );
    return (
        <Trace>
            <TraceCollapsible>
                <TraceCollapsibleTrigger>
                    <TraceLine>
                        <TraceIcon>
                            <ArchiveIcon />
                        </TraceIcon>
                        <TraceTitle>{t('chat.compacted')}</TraceTitle>
                    </TraceLine>
                </TraceCollapsibleTrigger>
                <TraceCollapsibleContent>
                    <Markdown className="text-sm">{compaction.summary ?? ''}</Markdown>
                </TraceCollapsibleContent>
            </TraceCollapsible>
        </Trace>
    );
}

/**
 * A notice line, shown for the kinds the user should see.
 * @param props The notice.
 * @param props.notice A committed or pending notice.
 * @returns The line, or null.
 */
function NoticeLine({ notice }: { notice: Notice }) {
    const { t } = useT();
    let text: string | null;
    switch (notice.kind) {
        case 'restarted':
            text = t('chat.restarted');
            break;
        case 'interrupted':
            text = notice.payload.reason === 'user' ? t('chat.userInterrupted') : null;
            break;
        case 'job-finished':
            text = t('tool.jobFinished', { tool: notice.payload.tool });
            break;
        case 'job-lost':
            text = t('tool.jobLost', { tool: notice.payload.tool });
            break;
        case 'workspace-changed':
            text = t('chat.workspace.changed', {
                name: notice.payload.to.split(/[\\/]/).filter(Boolean).at(-1) ?? notice.payload.to,
            });
            break;
    }
    if (!text) return null;
    return <p className="text-muted-foreground text-center text-xs">{text}</p>;
}

/**
 * Countdown to a scheduled retry.
 * @param props Retry state.
 * @param props.at When the retry starts.
 * @param props.number The next attempt number.
 * @returns The countdown text.
 */
function RetryCountdown({ at, number }: { at: string; number: number }) {
    const { t } = useT();
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 500);
        return () => clearInterval(timer);
    }, []);
    const seconds = Math.max(0, Math.ceil((Date.parse(at) - now) / 1000));
    return (
        <p className="text-muted-foreground text-xs">
            {t('chat.retrying', { seconds, number, max: 4 })}
        </p>
    );
}

/**
 * The conversation: committed history, queued input, the streaming draft, and run state.
 * @param props Session state.
 * @param props.view The session view.
 * @param props.older Earlier history pages the user loaded.
 * @param props.hasOlder Whether still earlier history exists.
 * @param props.onLoadOlder Load the next earlier page.
 * @param props.draft The streaming draft.
 * @param props.discarded The failure that discarded a draft before a retry.
 * @returns The transcript.
 */
export function Transcript({
    view,
    older,
    hasOlder,
    onLoadOlder,
    draft,
    discarded,
}: {
    view: SessionView;
    older: readonly HistoryEntry[];
    hasOlder: boolean;
    onLoadOlder: () => Promise<void>;
    draft?: Draft;
    discarded?: Failure;
}) {
    const { t } = useT();
    const pending = [...view.inbox.values()]
        .filter(item => item.item.type === 'message' || item.item.type === 'notice')
        .sort((left, right) => left.seq - right.seq);
    const failed =
        !view.run && view.lastRun?.result.outcome === 'failed'
            ? view.lastRun.result.failure
            : undefined;
    // Earlier pages the user loaded, then the latest page that live records extend.
    const history = [...older, ...view.history];
    const empty = history.length === 0 && pending.length === 0 && !draft;
    const results = new Map<string, ToolResult>();
    for (const entry of history)
        if (entry.item.type === 'tool_result') results.set(entry.item.callId, entry.item);
    const rows = rowsOf(history);
    // A running agent works in the last turn, even before its first output is committed.
    const working = Boolean(view.run || draft);
    if (working && rows.at(-1)?.kind !== 'turn') {
        const last = rows.at(-1);
        rows.push({
            kind: 'turn',
            entries: [],
            ...(last?.kind === 'user' ? { since: last.entry.at } : {}),
        });
    }

    /**
     * What one history entry adds to the transcript, after any compaction that ends there.
     * @param entry The entry.
     * @returns Its nodes.
     */
    const renderEntry = (entry: HistoryEntry): ReactNode[] => [
        // A succeeded compaction sits where the history it summarized ends.
        ...view.compactions
            .filter(compaction => compaction.from === entry.seq)
            .map(compaction => (
                <CompactionLine key={compaction.compactionId} compaction={compaction} />
            )),
        entry.item.type === 'message' && entry.item.role === 'user' ? (
            <UserBubble
                key={entry.item.id}
                text={textOf(entry.item.blocks, 'text')}
                media={{ sessionId: view.sessionId, blocks: mediaOf(entry.item.blocks) }}
            />
        ) : entry.item.type === 'message' ? (
            <AssistantOutput
                key={entry.item.id}
                text={textOf(entry.item.blocks, 'text')}
                reasoning={textOf(entry.item.blocks, 'reasoning')}
                {...reasoningTime(entry.item.blocks)}
                interrupted={entry.status === 'interrupted'}
                leading={entry.item.blocks.map(block =>
                    block.type === 'native_tool_call' ? (
                        <NativeToolView
                            key={`${block.tool}:${block.query ?? ''}:${(block.urls ?? []).join()}`}
                            block={block}
                        />
                    ) : null
                )}
            >
                {entry.item.blocks.map(block =>
                    block.type === 'tool_call' ? (
                        <ToolCallView
                            key={block.callId}
                            sessionId={view.sessionId}
                            block={block}
                            open={view.calls.find(item => item.callId === block.callId)}
                            result={results.get(block.callId)}
                            jobRunning={view.jobs.some(job => job.callId === block.callId)}
                        />
                    ) : null
                )}
            </AssistantOutput>
        ) : entry.item.type === 'notice' ? (
            <NoticeLine key={entry.item.id} notice={entry.item} />
        ) : null,
    ];

    return (
        <Conversation className="min-h-0 flex-1">
            <PullToLoad enabled={hasOlder} onLoad={onLoadOlder} loaded={older.length} />
            <ConversationContent className="mx-auto w-full max-w-3xl">
                {empty ? (
                    <ConversationEmptyState
                        icon={<MessageSquareIcon className="size-8" />}
                        title={t('chat.empty.start')}
                        description={t('chat.empty.description')}
                    />
                ) : null}
                {rows.map((row, index) => {
                    if (row.kind === 'user') return renderEntry(row.entry);
                    const current = index === rows.length - 1;
                    const over = !(current && working);
                    const first = row.since ?? row.entries[0]?.at;
                    const last = row.entries.at(-1)?.at;
                    return (
                        <Turn
                            key={row.entries[0]?.seq ?? 'working'}
                            footer={
                                over && row.entries.length > 0 ? (
                                    <TurnFooter
                                        text={turnText(row.entries)}
                                        {...(first && last
                                            ? { ms: Date.parse(last) - Date.parse(first) }
                                            : {})}
                                    />
                                ) : undefined
                            }
                        >
                            {row.entries.flatMap(renderEntry)}
                            {current && draft && (
                                <AssistantOutput
                                    text={draft.text}
                                    reasoning={draft.reasoning}
                                    streaming
                                />
                            )}
                            {current && view.run?.retry && (
                                <div className="flex flex-col gap-2">
                                    {discarded && (
                                        <FailureNotice
                                            failure={discarded}
                                            title={t('chat.failed')}
                                        />
                                    )}
                                    <RetryCountdown
                                        at={view.run.retry.at}
                                        number={view.run.retry.number}
                                    />
                                </div>
                            )}
                            {current && failed && (
                                <FailureNotice failure={failed} title={t('chat.failed')} />
                            )}
                        </Turn>
                    );
                })}
                {view.compactions
                    .filter(compaction => compaction.state !== 'succeeded')
                    .map(compaction => (
                        <CompactionLine key={compaction.compactionId} compaction={compaction} />
                    ))}
                {pending.map(item =>
                    item.item.type === 'notice' ? (
                        <NoticeLine key={item.deliveryId} notice={item.item} />
                    ) : item.item.type === 'message' ? (
                        <UserBubble
                            key={item.deliveryId}
                            text={textOf(item.item.blocks, 'text')}
                            media={{ sessionId: view.sessionId, blocks: mediaOf(item.item.blocks) }}
                            badge={t('chat.pending')}
                            onRemove={() =>
                                call('session.withdraw', {
                                    sessionId: view.sessionId,
                                    deliveryId: item.deliveryId,
                                })
                            }
                        />
                    ) : null
                )}
                {failed && rows.at(-1)?.kind !== 'turn' && (
                    <FailureNotice failure={failed} title={t('chat.failed')} />
                )}
            </ConversationContent>
            <ConversationScrollButton />
        </Conversation>
    );
}
