import {
    CheckIcon,
    EllipsisIcon,
    PencilIcon,
    PinIcon,
    PinOffIcon,
    Trash2Icon,
    XIcon,
} from 'lucide-react';
import { useState } from 'react';

import { ActionButton } from '../../components/action-button';
import { call } from '../../lib/client';
import { useT } from '../../lib/i18n';
import { useAction } from '../../lib/use-action';

import type { SessionInfo } from '../../../shared/ipc';
import type { MessageKey } from '../../lib/messages';

import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

type Group = { label: MessageKey; sessions: SessionInfo[] };

/**
 * Split sessions into Pinned, Today, and Earlier; empty groups are dropped.
 * @param sessions Sessions, most recently updated first.
 * @param now The current time.
 * @returns Groups in display order.
 */
function groupSessions(sessions: readonly SessionInfo[], now: Date): Group[] {
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const groups: Group[] = [
        { label: 'chat.group.pinned', sessions: sessions.filter(item => item.pinned) },
        {
            label: 'chat.group.today',
            sessions: sessions.filter(
                item => !item.pinned && Date.parse(item.updatedAt) >= startOfToday
            ),
        },
        {
            label: 'chat.group.earlier',
            sessions: sessions.filter(
                item => !item.pinned && Date.parse(item.updatedAt) < startOfToday
            ),
        },
    ];
    return groups.filter(group => group.sessions.length > 0);
}

/**
 * Rename a chat.
 * @param props Dialog props.
 * @param props.session The chat.
 * @param props.onClose Close the dialog.
 * @returns The dialog.
 */
function RenameDialog({ session, onClose }: { session: SessionInfo; onClose: () => void }) {
    const { t } = useT();
    const [title, setTitle] = useState(session.title);
    const save = useAction(async () => {
        await call('session.rename', { sessionId: session.sessionId, title: title.trim() });
        onClose();
    });
    return (
        <Dialog open onOpenChange={open => !open && onClose()}>
            <DialogContent className="sm:max-w-md">
                <form
                    className="flex flex-col gap-4"
                    onSubmit={event => {
                        event.preventDefault();
                        void save.run();
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>{t('chat.rename')}</DialogTitle>
                    </DialogHeader>
                    <Input
                        autoFocus
                        value={title}
                        maxLength={200}
                        aria-label={t('chat.rename')}
                        onChange={event => setTitle(event.currentTarget.value)}
                    />
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>
                            <XIcon /> {t('common.cancel')}
                        </Button>
                        <Button type="submit" disabled={!title.trim() || save.pending}>
                            <CheckIcon /> {t('common.save')}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/**
 * Confirm deleting a chat.
 * @param props Dialog props.
 * @param props.session The chat.
 * @param props.onClose Close the dialog.
 * @param props.onDeleted Called after deletion.
 * @returns The dialog.
 */
function DeleteDialog({
    session,
    onClose,
    onDeleted,
}: {
    session: SessionInfo;
    onClose: () => void;
    onDeleted: () => void;
}) {
    const { t } = useT();
    return (
        <Dialog open onOpenChange={open => !open && onClose()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{t('chat.delete.title')}</DialogTitle>
                    <DialogDescription>
                        {t('chat.delete.description', {
                            title: session.title || t('chat.untitled'),
                        })}
                    </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        <XIcon /> {t('common.cancel')}
                    </Button>
                    <ActionButton
                        variant="destructive"
                        icon={<Trash2Icon />}
                        action={async () => {
                            await call('session.delete', { sessionId: session.sessionId });
                            onDeleted();
                            onClose();
                        }}
                    >
                        {t('common.delete')}
                    </ActionButton>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/**
 * One chat in the list: title, time, and a menu shown on hover.
 * @param props Row props.
 * @param props.session The chat.
 * @param props.selected Whether it is open.
 * @param props.onSelect Open it.
 * @param props.onRename Ask to rename it.
 * @param props.onDelete Ask to delete it.
 * @returns The row.
 */
function SessionRow({
    session,
    selected,
    onSelect,
    onRename,
    onDelete,
}: {
    session: SessionInfo;
    selected: boolean;
    onSelect: () => void;
    onRename: () => void;
    onDelete: () => void;
}) {
    const { t, locale } = useT();
    const [menuOpen, setMenuOpen] = useState(false);
    const pin = useAction(() =>
        call('session.pin', { sessionId: session.sessionId, pinned: !session.pinned })
    );
    const updated = new Date(session.updatedAt);
    const today = updated.toDateString() === new Date().toDateString();
    const time = new Intl.DateTimeFormat(
        locale,
        today ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric' }
    ).format(updated);
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
                className="focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-2 rounded-xl py-2 pr-2 pl-3 text-left text-sm outline-none focus-visible:ring-2"
            >
                <span className="min-w-0 flex-1 truncate">
                    {session.title || t('chat.untitled')}
                </span>
                {session.running && (
                    <Spinner
                        className="text-primary size-3.5 shrink-0 motion-reduce:animate-none"
                        aria-label={t('chat.running')}
                    />
                )}
                <span
                    className={cn(
                        'text-muted-foreground shrink-0 text-xs tabular-nums group-hover/session:invisible group-focus-within/session:invisible',
                        menuOpen && 'invisible'
                    )}
                >
                    {time}
                </span>
            </button>
            <DropdownMenu modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
                <DropdownMenuTrigger asChild>
                    <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t('chat.actions')}
                        className={cn(
                            'absolute right-1.5 opacity-0 group-hover/session:opacity-100 focus-visible:opacity-100',
                            menuOpen && 'opacity-100'
                        )}
                    >
                        <EllipsisIcon />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuItem onSelect={onRename}>
                        <PencilIcon /> {t('chat.rename')}
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={pin.pending} onSelect={() => void pin.run()}>
                        {session.pinned ? <PinOffIcon /> : <PinIcon />}
                        {session.pinned ? t('chat.unpin') : t('chat.pin')}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                        <Trash2Icon /> {t('common.delete')}
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    );
}

/**
 * The chat list, grouped into Pinned, Today, and Earlier.
 * @param props List props.
 * @param props.sessions All chats.
 * @param props.selected The open chat.
 * @param props.onSelect Open a chat.
 * @param props.onDeleted Called after a chat is deleted.
 * @returns The list.
 */
export function SessionList({
    sessions,
    selected,
    onSelect,
    onDeleted,
}: {
    sessions: readonly SessionInfo[];
    selected: string | undefined;
    onSelect: (sessionId: string) => void;
    onDeleted: (sessionId: string) => void;
}) {
    const { t } = useT();
    const [renaming, setRenaming] = useState<SessionInfo | undefined>();
    const [deleting, setDeleting] = useState<SessionInfo | undefined>();
    if (sessions.length === 0)
        return <p className="text-muted-foreground px-3 py-1 text-xs">{t('chat.noSessions')}</p>;
    return (
        <>
            {groupSessions(sessions, new Date()).map(group => (
                <section key={group.label} className="flex flex-col gap-0.5">
                    <h3 className="text-muted-foreground px-3 pt-3 pb-1 text-xs">
                        {t(group.label)}
                    </h3>
                    {group.sessions.map(session => (
                        <SessionRow
                            key={session.sessionId}
                            session={session}
                            selected={session.sessionId === selected}
                            onSelect={() => onSelect(session.sessionId)}
                            onRename={() => setRenaming(session)}
                            onDelete={() => setDeleting(session)}
                        />
                    ))}
                </section>
            ))}
            {renaming && <RenameDialog session={renaming} onClose={() => setRenaming(undefined)} />}
            {deleting && (
                <DeleteDialog
                    session={deleting}
                    onClose={() => setDeleting(undefined)}
                    onDeleted={() => onDeleted(deleting.sessionId)}
                />
            )}
        </>
    );
}
