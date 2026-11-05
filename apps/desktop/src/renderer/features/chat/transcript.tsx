import { CheckIcon, CopyIcon, MessageSquareIcon, XIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { ActionButton } from '../../components/action-button';
import { call } from '../../lib/client';
import { useT } from '../../lib/i18n';

import { FailureNotice } from './failure-notice';
import { mathPlugin, normalizeMath } from './math';
import { NativeToolView, ToolCallView } from './tool-call';

import type { Draft } from './use-session';
import type {
    Block,
    Failure,
    HistoryEntry,
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
    MessageResponse,
} from '@/components/ai-elements/message';
import { Badge } from '@/components/ui/badge';
import {
    Trace,
    TraceCollapsible,
    TraceCollapsibleContent,
    TraceCollapsibleTrigger,
    TraceDescription,
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
 * Copy an answer's text to the clipboard.
 * @param props The text.
 * @param props.text Markdown of the answer.
 * @returns The action row.
 */
function CopyAction({ text }: { text: string }) {
    const { t } = useT();
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(false), 1500);
        return () => clearTimeout(timer);
    }, [copied]);
    return (
        <MessageActions className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <MessageAction
                tooltip={copied ? t('common.copied') : t('common.copy')}
                onClick={() =>
                    void navigator.clipboard.writeText(text).then(
                        () => setCopied(true),
                        () => toast.error(t('error.generic'))
                    )
                }
            >
                {copied ? <CheckIcon /> : <CopyIcon />}
            </MessageAction>
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
 * @param props.seconds Recorded duration in seconds.
 * @returns The line.
 */
function ReasoningLine({
    text,
    running,
    seconds,
}: {
    text: string;
    running: boolean;
    seconds?: number;
}) {
    const { t } = useT();
    const [open, setOpen] = useState<boolean>();
    return (
        <TraceCollapsible open={open ?? running} onOpenChange={setOpen}>
            <TraceCollapsibleTrigger>
                <TraceLine status={running ? 'running' : undefined}>
                    <TraceTitle>{running ? t('chat.thinkingNow') : t('chat.thought')}</TraceTitle>
                    {!running && seconds !== undefined && (
                        <TraceDescription>{t('chat.seconds', { seconds })}</TraceDescription>
                    )}
                </TraceLine>
            </TraceCollapsibleTrigger>
            <TraceCollapsibleContent>
                <MessageResponse className="text-sm" plugins={{ math: mathPlugin }}>
                    {normalizeMath(text)}
                </MessageResponse>
            </TraceCollapsibleContent>
        </TraceCollapsible>
    );
}

/**
 * One assistant or user message.
 * @param props Message parts.
 * @param props.role Who wrote it.
 * @param props.text Visible text.
 * @param props.reasoning Reasoning text.
 * @param props.reasoningMs How long the model reasoned, when recorded.
 * @param props.streaming Whether it is still streaming.
 * @param props.badge Optional status badge.
 * @param props.onRemove Optional remove action.
 * @param props.children Tool calls shown after the text.
 * @param props.leading Provider-executed calls, which happen before the answer text.
 * @returns The message.
 */
function Bubble({
    role,
    text,
    reasoning,
    reasoningMs,
    streaming,
    badge,
    onRemove,
    children,
    leading,
}: {
    role: 'user' | 'assistant';
    text: string;
    reasoning?: string;
    reasoningMs?: number;
    streaming?: boolean;
    badge?: string;
    onRemove?: () => Promise<unknown>;
    children?: ReactNode;
    leading?: ReactNode;
}) {
    const { t } = useT();
    return (
        <Message from={role}>
            <MessageContent>
                {reasoning || hasContent(leading) ? (
                    <Trace>
                        {reasoning ? (
                            <ReasoningLine
                                text={reasoning}
                                running={Boolean(streaming && !text)}
                                {...(reasoningMs !== undefined
                                    ? { seconds: Math.max(1, Math.ceil(reasoningMs / 1000)) }
                                    : {})}
                            />
                        ) : null}
                        {leading}
                    </Trace>
                ) : null}
                {role === 'assistant' && !text ? null : role === 'assistant' ? (
                    <MessageResponse plugins={{ math: mathPlugin }}>
                        {normalizeMath(text)}
                    </MessageResponse>
                ) : (
                    <p className="whitespace-pre-wrap">{text}</p>
                )}
                {hasContent(children) ? <Trace>{children}</Trace> : null}
                {role === 'assistant' && !streaming && text && <CopyAction text={text} />}
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
    );
}

/**
 * A notice line, shown for the kinds the user should see.
 * @param props The history entry.
 * @param props.entry A notice entry.
 * @returns The line, or null.
 */
function NoticeLine({ entry }: { entry: HistoryEntry }) {
    const { t } = useT();
    if (entry.item.type !== 'notice') return null;
    const notice = entry.item;
    const text =
        notice.kind === 'restarted'
            ? t('chat.restarted')
            : notice.kind === 'interrupted'
              ? notice.payload.reason === 'user'
                  ? t('chat.userInterrupted')
                  : null
              : notice.kind === 'job-finished'
                ? t('tool.jobFinished', { tool: notice.payload.tool })
                : t('tool.jobLost', { tool: notice.payload.tool });
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
 * @param props.draft The streaming draft.
 * @param props.discarded The failure that discarded a draft before a retry.
 * @returns The transcript.
 */
export function Transcript({
    view,
    draft,
    discarded,
}: {
    view: SessionView;
    draft?: Draft;
    discarded?: Failure;
}) {
    const { t } = useT();
    const pending = [...view.inbox.values()].filter(item => item.item.type === 'message');
    const failed =
        !view.run && view.lastRun?.result.outcome === 'failed'
            ? view.lastRun.result.failure
            : undefined;
    const empty = view.history.length === 0 && pending.length === 0 && !draft;
    const results = new Map<string, ToolResult>();
    for (const entry of view.history)
        if (entry.item.type === 'tool_result') results.set(entry.item.callId, entry.item);
    return (
        <Conversation className="min-h-0 flex-1">
            <ConversationContent className="mx-auto w-full max-w-3xl">
                {empty ? (
                    <ConversationEmptyState
                        icon={<MessageSquareIcon className="size-8" />}
                        title={t('chat.empty.start')}
                        description={t('chat.empty.description')}
                    />
                ) : null}
                {view.history.map(entry =>
                    entry.item.type === 'message' ? (
                        <Bubble
                            key={entry.item.id}
                            role={entry.item.role}
                            text={textOf(entry.item.blocks, 'text')}
                            reasoning={textOf(entry.item.blocks, 'reasoning')}
                            {...reasoningTime(entry.item.blocks)}
                            {...(entry.status === 'interrupted'
                                ? { badge: t('chat.interrupted') }
                                : {})}
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
                                        jobRunning={view.jobs.some(
                                            job => job.callId === block.callId
                                        )}
                                    />
                                ) : null
                            )}
                        </Bubble>
                    ) : entry.item.type === 'notice' ? (
                        <NoticeLine key={entry.item.id} entry={entry} />
                    ) : null
                )}
                {pending.map(item =>
                    item.item.type === 'message' ? (
                        <Bubble
                            key={item.deliveryId}
                            role="user"
                            text={textOf(item.item.blocks, 'text')}
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
                {draft && (
                    <Bubble
                        role="assistant"
                        text={draft.text}
                        reasoning={draft.reasoning}
                        streaming
                    />
                )}
                {view.run?.retry && (
                    <div className="flex flex-col gap-2">
                        {discarded && (
                            <FailureNotice failure={discarded} title={t('chat.failed')} />
                        )}
                        <RetryCountdown at={view.run.retry.at} number={view.run.retry.number} />
                    </div>
                )}
                {failed && <FailureNotice failure={failed} title={t('chat.failed')} />}
            </ConversationContent>
            <ConversationScrollButton />
        </Conversation>
    );
}
