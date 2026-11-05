import { FolderIcon, FolderOpenIcon, HouseIcon } from 'lucide-react';

import { chooseDirectory } from '../../lib/client';
import { useT } from '../../lib/i18n';

import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
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
 * The chat's workspace folder: a picker before the chat starts, read-only afterwards.
 * @param props Picker props.
 * @param props.workspace The chosen folder.
 * @param props.fallback The folder used when none is chosen.
 * @param props.onChange Set or clear the folder; absent once the chat exists.
 * @returns The picker.
 */
export function WorkspacePicker({
    workspace,
    fallback,
    onChange,
}: {
    workspace: string | undefined;
    fallback: string;
    onChange?: (workspace: string | undefined) => void;
}) {
    const { t } = useT();
    const effective = onChange ? (workspace ?? fallback) : workspace;
    const label = effective ? folderName(effective) : t('chat.workspace.none');
    if (!onChange)
        return (
            <span
                className="text-muted-foreground flex max-w-48 items-center gap-1.5 px-2 text-xs"
                title={workspace ?? t('chat.workspace.hint')}
            >
                <FolderIcon className="size-3.5 shrink-0" />
                <span className="truncate">{label}</span>
            </span>
        );
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="max-w-48"
                    aria-label={t('chat.workspace')}
                    title={effective}
                >
                    <FolderIcon />
                    <span className="truncate">{label}</span>
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
                    {t('chat.workspace.hint')}
                </DropdownMenuLabel>
                <DropdownMenuItem
                    onSelect={() => void chooseDirectory().then(path => path && onChange(path))}
                >
                    <FolderOpenIcon />
                    {t('chat.workspace.choose')}
                </DropdownMenuItem>
                {workspace && (
                    <DropdownMenuItem onSelect={() => onChange(undefined)}>
                        <HouseIcon />
                        {t('chat.workspace.clear')}
                    </DropdownMenuItem>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
