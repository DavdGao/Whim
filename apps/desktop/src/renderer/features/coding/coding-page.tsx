import { Button } from '@whimkit/ui/components/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@whimkit/ui/components/dropdown-menu';
import {
    Empty,
    EmptyContent,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
} from '@whimkit/ui/components/empty';
import { Skeleton } from '@whimkit/ui/components/skeleton';
import { cn } from '@whimkit/ui/lib/utils';
import {
    EllipsisIcon,
    LaptopIcon,
    PencilIcon,
    PlusIcon,
    RotateCwIcon,
    ServerIcon,
    SquareTerminalIcon,
    Trash2Icon,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { ChoiceMenu } from '../../components/choice-menu';
import { StatusAlert } from '../../components/status-alert';
import { call } from '../../lib/client';
import { useT } from '../../lib/i18n';

import { agentName } from './agent-name';
import { ConfirmDialog, HostDialog, NewSessionDialog } from './coding-dialogs';
import { readLastView, writeLastView } from './last-view';
import { TerminalView } from './terminal-view';
import { useInventory } from './use-inventory';

import type { AppState, CodingHost, CodingSession } from '../../../shared/ipc';
import type { PageProps } from '../../lib/navigation';

type Dialog =
    | { readonly kind: 'host'; readonly host: CodingHost | undefined }
    | { readonly kind: 'removeHost'; readonly host: CodingHost }
    | { readonly kind: 'new' }
    | { readonly kind: 'end'; readonly session: CodingSession };

/**
 * The last segment of a path.
 * @param path A folder path.
 * @returns Its name.
 */
function folderName(path: string): string {
    return path.split('/').filter(Boolean).pop() ?? path;
}

/**
 * One session in the list.
 * @param props Row props.
 * @param props.state Application state, for agent names.
 * @param props.session The session.
 * @param props.selected Whether it is open.
 * @param props.onSelect Open it.
 * @param props.onEnd Ask to end it.
 * @returns The row.
 */
function SessionRow({
    state,
    session,
    selected,
    onSelect,
    onEnd,
}: {
    state: AppState;
    session: CodingSession;
    selected: boolean;
    onSelect: () => void;
    onEnd: () => void;
}) {
    const { t } = useT();
    const [menuOpen, setMenuOpen] = useState(false);
    const agent = state.codingAgents.find(item => item.id === session.agentId);
    return (
        <div
            className={cn(
                'group/session hover:bg-accent relative flex items-center rounded-xl',
                (selected || menuOpen) && 'bg-accent'
            )}
        >
            <button
                type="button"
                onClick={onSelect}
                aria-current={selected ? 'page' : undefined}
                className="focus-visible:ring-ring flex min-w-0 flex-1 flex-col rounded-xl py-2 pr-9 pl-3 text-left outline-none focus-visible:ring-2"
            >
                <span className="truncate text-sm">
                    {agent ? agentName(state, agent) : session.name}
                </span>
                <span className="text-muted-foreground truncate text-xs" title={session.folder}>
                    {folderName(session.folder)} · {session.name}
                </span>
            </button>
            <DropdownMenu modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
                <DropdownMenuTrigger asChild>
                    <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t('coding.actions')}
                        className={cn(
                            'absolute right-1.5 opacity-0 group-hover/session:opacity-100 focus-visible:opacity-100',
                            menuOpen && 'opacity-100'
                        )}
                    >
                        <EllipsisIcon />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuItem variant="destructive" onSelect={onEnd}>
                        <Trash2Icon /> {t('coding.end')}
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    );
}

/**
 * The Coding page: a computer, its tmux sessions, and the open session's terminal.
 * @param props Application state.
 * @param props.state Application state.
 * @returns The page.
 */
export function CodingPage({ state }: PageProps) {
    const { t } = useT();
    // The page opens on the computer and session last opened, each computer keeping its own.
    const [view, setView] = useState(readLastView);
    useEffect(() => writeLastView(view), [view]);
    // A removed host falls back to this Mac.
    const hostId =
        view.hostId === 'local' || state.codingHosts.some(host => host.id === view.hostId)
            ? view.hostId
            : 'local';
    const host = state.codingHosts.find(item => item.id === hostId);
    const [dialog, setDialog] = useState<Dialog>();
    const { inventory, error, refresh } = useInventory(hostId);
    const chooseHost = (id: string) => setView(current => ({ ...current, hostId: id }));
    // A remembered session opens once a listing shows it still exists (a restarted tmux server
    // gives sessions new keys); once open, a failed listing does not close its terminal.
    const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
    const remembered = view.sessions[hostId];
    const listed =
        remembered !== undefined && inventory?.status === 'ok'
            ? inventory.sessions.some(session => session.key === remembered)
            : undefined;
    const rememberedId = remembered === undefined ? undefined : `${hostId}:${remembered}`;
    const openKey = rememberedId && (listed || opened.has(rememberedId)) ? remembered : undefined;
    // Settled while rendering, as each new listing arrives, so no effect re-renders the page.
    if (rememberedId && listed && !opened.has(rememberedId))
        setOpened(new Set(opened).add(rememberedId));
    if (rememberedId && listed === false && !opened.has(rememberedId)) {
        const sessions = { ...view.sessions };
        delete sessions[hostId];
        setView({ ...view, sessions });
    }
    const select = (key: string | undefined) => {
        if (key) setOpened(current => new Set(current).add(`${hostId}:${key}`));
        setView(current => {
            const sessions = { ...current.sessions };
            if (key) sessions[hostId] = key;
            else delete sessions[hostId];
            return { hostId, sessions };
        });
    };

    return (
        <div className="flex h-full min-h-0">
            <aside className="bg-muted/30 flex w-64 shrink-0 flex-col border-r">
                <div className="flex items-center gap-1 px-3 py-3">
                    <ChoiceMenu
                        value={hostId}
                        choices={[
                            {
                                value: 'local',
                                label: t('coding.host.local'),
                                icon: <LaptopIcon />,
                            },
                            ...state.codingHosts.map(item => ({
                                value: item.id,
                                label: item.label,
                                icon: <ServerIcon />,
                            })),
                        ]}
                        onChange={chooseHost}
                        icon={<LaptopIcon />}
                        placeholder={t('coding.host')}
                        aria-label={t('coding.host')}
                        variant="ghost"
                        size="sm"
                        className="min-w-0 flex-1"
                    />
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                size="icon-sm"
                                variant="ghost"
                                aria-label={t('coding.host.actions')}
                            >
                                <EllipsisIcon />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48">
                            <DropdownMenuItem
                                onSelect={() => setDialog({ kind: 'host', host: undefined })}
                            >
                                <PlusIcon /> {t('coding.host.add')}
                            </DropdownMenuItem>
                            {host && (
                                <>
                                    <DropdownMenuItem
                                        onSelect={() => setDialog({ kind: 'host', host })}
                                    >
                                        <PencilIcon /> {t('coding.host.edit')}
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                        variant="destructive"
                                        onSelect={() => setDialog({ kind: 'removeHost', host })}
                                    >
                                        <Trash2Icon /> {t('coding.host.remove')}
                                    </DropdownMenuItem>
                                </>
                            )}
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
                <div className="flex items-center justify-between px-3 pb-1">
                    <h2 className="text-muted-foreground text-xs">{t('coding.sessions')}</h2>
                    <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t('coding.new')}
                        disabled={inventory?.status !== 'ok'}
                        onClick={() => setDialog({ kind: 'new' })}
                    >
                        <PlusIcon />
                    </Button>
                </div>
                <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
                    <nav
                        className="flex flex-col gap-0.5 px-2 pb-3"
                        aria-label={t('coding.sessions')}
                    >
                        {error ? (
                            <StatusAlert tone="error">{error}</StatusAlert>
                        ) : !inventory ? (
                            <>
                                <Skeleton className="h-11 rounded-xl" />
                                <Skeleton className="h-11 rounded-xl" />
                            </>
                        ) : inventory.status === 'tmux-missing' ? (
                            <StatusAlert tone="warning" title={t('coding.tmuxMissing.title')}>
                                {t('coding.tmuxMissing.description')}
                            </StatusAlert>
                        ) : inventory.status === 'unreachable' ? (
                            <StatusAlert tone="error" title={t('coding.unreachable.title')}>
                                <span className="break-words">{inventory.detail}</span>
                            </StatusAlert>
                        ) : inventory.sessions.length === 0 ? (
                            <p className="text-muted-foreground px-3 py-1 text-xs">
                                {t('coding.noSessions')}
                            </p>
                        ) : (
                            inventory.sessions.map(session => (
                                <SessionRow
                                    key={session.key}
                                    state={state}
                                    session={session}
                                    selected={session.key === openKey}
                                    onSelect={() => select(session.key)}
                                    onEnd={() => setDialog({ kind: 'end', session })}
                                />
                            ))
                        )}
                        {(error || (inventory && inventory.status !== 'ok')) && (
                            <Button
                                variant="ghost"
                                size="sm"
                                className="mt-2 self-start"
                                onClick={refresh}
                            >
                                <RotateCwIcon /> {t('common.retry')}
                            </Button>
                        )}
                    </nav>
                </div>
            </aside>
            <section className="flex min-w-0 flex-1 flex-col">
                {openKey ? (
                    <TerminalView
                        key={`${hostId}:${openKey}`}
                        hostId={hostId}
                        sessionKey={openKey}
                        onEnded={refresh}
                    />
                ) : (
                    <Empty className="flex-1">
                        <EmptyHeader>
                            <EmptyMedia variant="icon">
                                <SquareTerminalIcon />
                            </EmptyMedia>
                            <EmptyTitle>{t('coding.empty.title')}</EmptyTitle>
                            <EmptyDescription>{t('coding.empty.description')}</EmptyDescription>
                        </EmptyHeader>
                        <EmptyContent>
                            <Button
                                disabled={inventory?.status !== 'ok'}
                                onClick={() => setDialog({ kind: 'new' })}
                            >
                                <PlusIcon /> {t('coding.new')}
                            </Button>
                        </EmptyContent>
                    </Empty>
                )}
            </section>
            {dialog?.kind === 'host' && (
                <HostDialog
                    host={dialog.host}
                    onSaved={chooseHost}
                    onClose={() => setDialog(undefined)}
                />
            )}
            {dialog?.kind === 'removeHost' && (
                <ConfirmDialog
                    title={t('coding.host.remove.title', { label: dialog.host.label })}
                    description={t('coding.host.remove.description')}
                    confirm={t('coding.host.remove')}
                    action={() => call('coding.removeHost', { id: dialog.host.id })}
                    onClose={() => setDialog(undefined)}
                />
            )}
            {dialog?.kind === 'new' && (
                <NewSessionDialog
                    state={state}
                    hostId={hostId}
                    onStarted={key => {
                        select(key);
                        refresh();
                    }}
                    onClose={() => setDialog(undefined)}
                />
            )}
            {dialog?.kind === 'end' && (
                <ConfirmDialog
                    title={t('coding.end.title', { name: dialog.session.name })}
                    description={t('coding.end.description')}
                    confirm={t('coding.end')}
                    action={async () => {
                        await call('coding.kill', { hostId, key: dialog.session.key });
                        if (openKey === dialog.session.key) select(undefined);
                        refresh();
                    }}
                    onClose={() => setDialog(undefined)}
                />
            )}
        </div>
    );
}
