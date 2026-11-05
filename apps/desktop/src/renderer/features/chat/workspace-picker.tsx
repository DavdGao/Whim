import { ExternalLinkIcon, FolderIcon, FolderOpenIcon, HouseIcon } from 'lucide-react';

import { chooseDirectory, openDirectory } from '../../lib/client';
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
 * The chat's workspace folder as a menu: choose or reset it before the chat starts, and open it
 * in the file manager at any time.
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
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="text-muted-foreground hover:text-foreground max-w-48 rounded-full font-normal"
                    aria-label={t('chat.workspace')}
                    title={effective}
                >
                    <FolderIcon />
                    <span className="truncate">{label}</span>
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72">
                <DropdownMenuLabel className="flex flex-col gap-1 text-xs font-normal">
                    {effective && <span className="truncate font-medium">{effective}</span>}
                    <span className="text-muted-foreground">
                        {onChange ? t('chat.workspace.hint') : t('chat.workspace.fixed')}
                    </span>
                </DropdownMenuLabel>
                {effective && (
                    <DropdownMenuItem onSelect={() => void openDirectory(effective)}>
                        <ExternalLinkIcon />
                        {t('chat.workspace.open')}
                    </DropdownMenuItem>
                )}
                {onChange && (
                    <DropdownMenuItem
                        onSelect={() => void chooseDirectory().then(path => path && onChange(path))}
                    >
                        <FolderOpenIcon />
                        {t('chat.workspace.choose')}
                    </DropdownMenuItem>
                )}
                {onChange && workspace && (
                    <DropdownMenuItem onSelect={() => onChange(undefined)}>
                        <HouseIcon />
                        {t('chat.workspace.clear')}
                    </DropdownMenuItem>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
