import {
    ChevronDownIcon,
    ExternalLinkIcon,
    FolderIcon,
    FolderOpenIcon,
    GitBranchIcon,
    HouseIcon,
    MinusIcon,
    PlusIcon,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { call, chooseDirectory, openDirectory } from '../../lib/client';
import { useT } from '../../lib/i18n';

import type { GitStatus } from '../../../shared/ipc';

import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * The last segment of a path, for compact display.
 * @param path An absolute path.
 * @returns The folder name.
 */
function folderName(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/**
 * Git status of a folder, refreshed when the folder or `refresh` changes and when the window
 * regains focus.
 * @param path The folder.
 * @param refresh Changes when the folder may have changed, such as after a run.
 * @returns The status (null outside a repository) and a reload function.
 */
function useGitStatus(path: string, refresh: unknown) {
    const [status, setStatus] = useState<GitStatus | null>(null);
    const load = useCallback(() => {
        call('workspace.git', { path }).then(setStatus, () => setStatus(null));
    }, [path]);
    useEffect(() => {
        load();
    }, [load, refresh]);
    useEffect(() => {
        window.addEventListener('focus', load);
        return () => window.removeEventListener('focus', load);
    }, [load]);
    return { status, load };
}

/**
 * `+N −M` line counts, hidden when the tree is clean.
 * @param props Counts.
 * @param props.insertions Added lines.
 * @param props.deletions Removed lines.
 * @returns The counts, or null.
 */
function DiffStats({ insertions, deletions }: { insertions: number; deletions: number }) {
    if (insertions === 0 && deletions === 0) return null;
    const format = new Intl.NumberFormat(undefined, { notation: 'compact' });
    return (
        <span className="flex items-center gap-1 text-xs tabular-nums">
            <span className="flex items-center text-emerald-600 dark:text-emerald-400">
                <PlusIcon className="size-2.5" />
                {format.format(insertions)}
            </span>
            <span className="flex items-center text-red-600 dark:text-red-400">
                <MinusIcon className="size-2.5" />
                {format.format(deletions)}
            </span>
        </span>
    );
}

/**
 * The folder a chat works in, shown above the input once the user picked one: a menu to open,
 * change, or reset it, and the repository branch with uncommitted line counts.
 * @param props Bar props.
 * @param props.workspace The chosen folder.
 * @param props.locked Whether the folder cannot change now (a run is active).
 * @param props.refresh Changes when the folder's git status may have changed.
 * @param props.onChange Change the folder, or reset it to the default with undefined.
 * @returns The bar.
 */
export function WorkspaceBar({
    workspace,
    locked,
    refresh,
    onChange,
}: {
    workspace: string;
    locked: boolean;
    refresh: unknown;
    onChange: (workspace: string | undefined) => void;
}) {
    const { t } = useT();
    const { status, load } = useGitStatus(workspace, refresh);
    return (
        <div className="flex items-center justify-between gap-2 px-1.5 py-1">
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="text-muted-foreground hover:text-foreground min-w-0 rounded-full font-normal"
                        aria-label={t('chat.workspace')}
                        title={workspace}
                    >
                        <FolderIcon />
                        <span className="max-w-48 truncate">{folderName(workspace)}</span>
                        <ChevronDownIcon />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-72">
                    <DropdownMenuLabel className="flex flex-col gap-1 text-xs font-normal">
                        <span className="truncate">{workspace}</span>
                        <span className="text-muted-foreground">{t('chat.workspace.hint')}</span>
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => void openDirectory(workspace)}>
                        <ExternalLinkIcon />
                        {t('chat.workspace.open')}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        disabled={locked}
                        onSelect={() => void chooseDirectory().then(path => path && onChange(path))}
                    >
                        <FolderOpenIcon />
                        {t('chat.workspace.change')}
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={locked} onSelect={() => onChange(undefined)}>
                        <HouseIcon />
                        {t('chat.workspace.clear')}
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            {status && (
                <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="text-muted-foreground hover:text-foreground min-w-0 rounded-full font-mono font-normal"
                    title={t('chat.workspace.gitRefresh')}
                    onClick={load}
                >
                    <GitBranchIcon />
                    <span className="max-w-40 truncate">{status.head}</span>
                    <DiffStats insertions={status.insertions} deletions={status.deletions} />
                </Button>
            )}
        </div>
    );
}
