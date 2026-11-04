import { MessageSquareIcon, XIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import { call } from '../../lib/client';
import { useT } from '../../lib/i18n';

import { FailureNotice } from './failure-notice';

import type { Draft } from './use-session';
import type { Block, Failure, HistoryEntry, SessionView } from '@whimkit/core/contracts';

import {
    Conversation,
    ConversationContent,
    ConversationEmptyState,
    ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

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
 * One assistant or user message.
 * @param props Message parts.
 * @param props.role Who wrote it.
 * @param props.text Visible text.
 * @param props.reasoning Reasoning text.
 * @param props.streaming Whether it is still streaming.
 * @param props.badge Optional status badge.
 * @param props.onRemove Optional remove action.
 * @returns The message.
 */
function Bubble({
    role,
    text,
    reasoning,
    streaming,
    badge,
    onRemove,
}: {
    role: 'user' | 'assistant';
    text: string;
    reasoning?: string;
    streaming?: boolean;
    badge?: string;
    onRemove?: () => void;
}) {
    const { t } = useT();
    return (
        <Message from={role}>
            <MessageContent>
                {reasoning ? (
                    <Reasoning isStreaming={Boolean(streaming && !text)} defaultOpen={false}>
                        <ReasoningTrigger>{t('chat.reasoning')}</ReasoningTrigger>
                        <ReasoningContent>{reasoning}</ReasoningContent>
                    </Reasoning>
                ) : null}
                {role === 'assistant' ? (
                    <MessageResponse>{text}</MessageResponse>
                ) : (
                    <p className="whitespace-pre-wrap">{text}</p>
                )}
                {(badge || onRemove) && (
                    <div className="flex items-center gap-2">
                        {badge && <Badge variant="secondary">{badge}</Badge>}
                        {onRemove && (
                            <Button size="xs" variant="ghost" onClick={onRemove}>
                                <XIcon /> {t('chat.withdraw')}
                            </Button>
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
    const text =
        entry.item.kind === 'restarted'
            ? t('chat.restarted')
            : entry.item.payload.reason === 'user'
              ? t('chat.userInterrupted')
              : null;
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
    return (
        <Conversation className="min-h-0 flex-1">
            <ConversationContent className="mx-auto w-full max-w-3xl">
                {empty ? (
                    <ConversationEmptyState
                        icon={<MessageSquareIcon className="size-8" />}
                        title={t('chat.empty.title')}
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
                            {...(entry.status === 'interrupted'
                                ? { badge: t('chat.interrupted') }
                                : {})}
                        />
                    ) : (
                        <NoticeLine key={entry.item.id} entry={entry} />
                    )
                )}
                {pending.map(item =>
                    item.item.type === 'message' ? (
                        <Bubble
                            key={item.deliveryId}
                            role="user"
                            text={textOf(item.item.blocks, 'text')}
                            badge={t('chat.pending')}
                            onRemove={() =>
                                void call('session.withdraw', {
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
