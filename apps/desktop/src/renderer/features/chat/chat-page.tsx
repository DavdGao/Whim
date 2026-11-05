import { BoxesIcon, PlayIcon, PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { ActionButton } from '../../components/action-button';
import { AgentAvatar } from '../../components/agent-avatar';
import { call, ClientError } from '../../lib/client';
import { useT } from '../../lib/i18n';

import { Composer } from './composer';
import { modelChoices } from './model-choices';
import { SessionList } from './session-list';
import { Transcript } from './transcript';
import { useSession } from './use-session';

import type { AppState, ChatSlot } from '../../../shared/ipc';

import { StatusAlert } from '@/components/status-alert';
import { Button } from '@/components/ui/button';
import {
    Empty,
    EmptyContent,
    EmptyDescription,
    EmptyHeader,
    EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';

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
    const [workspace, setWorkspace] = useState<string | undefined>();
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
                sessionId = (
                    await call('session.create', {
                        slot,
                        ...(workspace ? { workspace } : {}),
                    })
                ).sessionId;
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
                {/* A plain scroller: Radix ScrollArea lays content out as a table, so long titles
                    widened rows and pushed the time and menu out of view. */}
                <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
                    <nav className="flex flex-col px-2 pb-3" aria-label={t('chat.sessions')}>
                        <SessionList
                            sessions={state.sessions}
                            selected={selected}
                            onSelect={setSelected}
                            onDeleted={sessionId =>
                                setSelected(current =>
                                    current === sessionId ? undefined : current
                                )
                            }
                        />
                    </nav>
                </div>
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
                            <div className="mx-auto w-full max-w-3xl p-6">
                                <StatusAlert tone="error" title={t('chat.unreadable')}>
                                    {session.error}
                                </StatusAlert>
                            </div>
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
                                <div className="flex flex-col items-center text-center">
                                    <AgentAvatar
                                        icon={state.agent.icon}
                                        className="mb-4 size-14 rounded-2xl"
                                    />
                                    <h1 className="text-2xl font-semibold tracking-tight">
                                        {t('chat.empty.title', { name: state.agent.name })}
                                    </h1>
                                    <p className="text-muted-foreground mt-1 text-sm">
                                        {t('chat.empty.description')}
                                    </p>
                                </div>
                            </div>
                        )}
                        <div className="flex flex-col gap-2 px-4 pt-2 pb-1.5">
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
                                workspace={view ? view.workspace : workspace}
                                usage={view?.lastUsage}
                                agentName={state.agent.name}
                                {...(selected ? {} : { onWorkspaceChange: setWorkspace })}
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
