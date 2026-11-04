import { BoxesIcon, MessageSquareIcon, PlayIcon, PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { ActionButton } from '../../components/action-button';
import { call, ClientError } from '../../lib/client';
import { useT } from '../../lib/i18n';

import { Composer } from './composer';
import { modelChoices } from './model-choices';
import { Transcript } from './transcript';
import { useSession } from './use-session';

import type { AppState, ChatSlot } from '../../../shared/ipc';

import { Button } from '@/components/ui/button';
import {
    Empty,
    EmptyContent,
    EmptyDescription,
    EmptyHeader,
    EmptyTitle,
} from '@/components/ui/empty';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * Report a failed command as a toast.
 * @param error The thrown value.
 * @param fallback Text when the error has no message.
 */
function notify(error: unknown, fallback: string): void {
    toast.error(error instanceof ClientError ? error.message : fallback);
}

/**
 * The chat page: session list and the selected conversation.
 * @param props Application state and navigation.
 * @param props.state Application state.
 * @param props.onOpenModels Navigate to the Models page.
 * @returns The page.
 */
export function ChatPage({ state, onOpenModels }: { state: AppState; onOpenModels: () => void }) {
    const { t } = useT();
    const [selected, setSelected] = useState<string | undefined>(state.sessions[0]?.sessionId);
    const session = useSession(selected);
    const view = session.view;
    const hasModels = modelChoices(state).length > 0;
    const fallbackSlot = state.chatSlot ?? firstSlot(state);
    const slot: ChatSlot | undefined = view
        ? {
              cardId: view.epoch.card.id,
              credentialId: view.credentialId,
              ...(view.thinking ? { thinking: view.thinking } : {}),
          }
        : fallbackSlot;
    const running = Boolean(view?.run);

    const changeSlot = async (next: ChatSlot) => {
        if (!view) await call('settings.chatSlot', { slot: next });
        else if (next.cardId !== view.epoch.card.id || next.credentialId !== view.credentialId)
            await call('session.switchModel', {
                sessionId: view.sessionId,
                cardId: next.cardId,
                credentialId: next.credentialId,
            });
        else if (next.thinking && next.thinking !== view.thinking)
            await call('session.setThinking', {
                sessionId: view.sessionId,
                thinking: next.thinking,
            });
    };
    const send = async (text: string) => {
        try {
            let sessionId = selected;
            if (!sessionId) {
                if (!slot) return;
                sessionId = (await call('session.create', { slot })).sessionId;
                setSelected(sessionId);
            }
            await call('session.send', { sessionId, text });
        } catch (error) {
            notify(error, t('error.generic'));
            throw error;
        }
    };

    return (
        <div className="flex h-full min-h-0">
            <aside className="bg-muted/30 flex w-64 shrink-0 flex-col border-r">
                <div className="flex items-center justify-between px-3 py-3">
                    <h2 className="text-sm font-medium">{t('chat.sessions')}</h2>
                    <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t('chat.new')}
                        onClick={() => setSelected(undefined)}
                    >
                        <PlusIcon />
                    </Button>
                </div>
                <ScrollArea className="min-h-0 flex-1">
                    <nav
                        className="flex flex-col gap-0.5 px-2 pb-3"
                        aria-label={t('chat.sessions')}
                    >
                        {state.sessions.length === 0 && (
                            <p className="text-muted-foreground px-2 py-1 text-xs">
                                {t('chat.noSessions')}
                            </p>
                        )}
                        {state.sessions.map(item => (
                            <button
                                key={item.sessionId}
                                type="button"
                                onClick={() => setSelected(item.sessionId)}
                                aria-current={item.sessionId === selected ? 'page' : undefined}
                                className={cn(
                                    'hover:bg-accent focus-visible:ring-ring flex items-center gap-2 rounded-xl px-2.5 py-2 text-left text-sm outline-none focus-visible:ring-2',
                                    item.sessionId === selected && 'bg-accent font-medium'
                                )}
                            >
                                <MessageSquareIcon className="text-muted-foreground size-4 shrink-0" />
                                <span className="min-w-0 flex-1 truncate">
                                    {item.title || t('chat.untitled')}
                                </span>
                                {item.running && (
                                    <span className="bg-primary size-1.5 shrink-0 animate-pulse rounded-full" />
                                )}
                            </button>
                        ))}
                    </nav>
                </ScrollArea>
            </aside>
            <section className="flex min-w-0 flex-1 flex-col">
                {!hasModels ? (
                    <Empty className="flex-1">
                        <EmptyHeader>
                            <EmptyTitle>{t('chat.setup.title')}</EmptyTitle>
                            <EmptyDescription>{t('chat.setup.description')}</EmptyDescription>
                        </EmptyHeader>
                        <EmptyContent>
                            <Button onClick={onOpenModels}>
                                <BoxesIcon /> {t('chat.setup.action')}
                            </Button>
                        </EmptyContent>
                    </Empty>
                ) : (
                    <>
                        {session.error ? (
                            <p className="text-destructive p-6 text-sm">
                                {t('chat.unreadable')} {session.error}
                            </p>
                        ) : selected && !view ? (
                            <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-3 p-6">
                                <Skeleton className="h-6 w-1/2" />
                                <Skeleton className="h-6 w-2/3 self-end" />
                            </div>
                        ) : view ? (
                            <Transcript
                                view={view}
                                {...(session.draft ? { draft: session.draft } : {})}
                                {...(session.discarded ? { discarded: session.discarded } : {})}
                            />
                        ) : (
                            <div className="flex flex-1 items-center justify-center">
                                <div className="text-center">
                                    <h1 className="text-2xl font-semibold tracking-tight">
                                        {t('chat.empty.title')}
                                    </h1>
                                    <p className="text-muted-foreground mt-1 text-sm">
                                        {t('chat.empty.description')}
                                    </p>
                                </div>
                            </div>
                        )}
                        <div className="flex flex-col gap-2 px-4 pt-2 pb-4">
                            {view &&
                                !view.run &&
                                view.lastRun?.result.outcome === 'interrupted' && (
                                    <div className="mx-auto">
                                        <ActionButton
                                            size="sm"
                                            variant="outline"
                                            icon={<PlayIcon />}
                                            action={() =>
                                                call('session.continue', {
                                                    sessionId: view.sessionId,
                                                })
                                            }
                                        >
                                            {t('chat.continue')}
                                        </ActionButton>
                                    </div>
                                )}
                            <Composer
                                state={state}
                                slot={slot}
                                running={running}
                                modelLocked={running}
                                onSlotChange={changeSlot}
                                onSend={send}
                                onStop={() =>
                                    view &&
                                    void call('session.stop', { sessionId: view.sessionId }).catch(
                                        error => notify(error, t('error.generic'))
                                    )
                                }
                            />
                        </div>
                    </>
                )}
            </section>
        </div>
    );
}

/**
 * The first usable model, for when no default is configured.
 * @param state Application state.
 * @returns A slot, or undefined.
 */
function firstSlot(state: AppState): ChatSlot | undefined {
    const choice = modelChoices(state)[0];
    return choice ? { cardId: choice.card.id, credentialId: choice.credentialId } : undefined;
}
