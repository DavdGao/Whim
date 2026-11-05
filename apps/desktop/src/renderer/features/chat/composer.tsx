import { ArrowUpIcon, FolderOpenIcon, PaperclipIcon, PlusIcon, SquareIcon } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';

import { chooseDirectory } from '../../lib/client';
import { useT } from '../../lib/i18n';

import { ContextUsage } from './context-usage';
import { modelChoices } from './model-choices';
import { ModelPicker } from './model-picker';
import { useAttachments } from './use-attachments';
import { WorkspaceBar } from './workspace-bar';

import type { PendingAttachment } from './use-attachments';
import type { AppState, ChatSlot } from '../../../shared/ipc';
import type { Usage } from '@whimkit/core/contracts';

import {
    Attachment,
    AttachmentInfo,
    AttachmentPreview,
    AttachmentRemove,
    Attachments,
} from '@/components/ai-elements/attachments';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

/** One line of text; the collapsed field is one line plus padding. */
const lineHeight = 22;
const collapsedHeight = 52;
const paddingY = (collapsedHeight - lineHeight) / 2;
const maxHeight = lineHeight * 8 + paddingY * 2;

export interface ComposerProps {
    readonly state: AppState;
    /** The current model binding, from the session or the default slot. */
    readonly slot: ChatSlot | undefined;
    readonly running: boolean;
    readonly modelLocked: boolean;
    readonly onSlotChange: (slot: ChatSlot) => Promise<void>;
    readonly onSend: (
        text: string,
        attachments: readonly { sha256: string; name: string }[]
    ) => Promise<void>;
    readonly onStop: () => void;
    /** The chat's folder; the default folder is not shown. */
    readonly workspace: string | undefined;
    /** The latest reported usage, for the context indicator. */
    readonly usage: Usage | undefined;
    /** The agent's display name, used in the placeholder. */
    readonly agentName: string;
    /** Choose a folder, or reset to the default with undefined. */
    readonly onWorkspaceChange: (workspace: string | undefined) => void;
    /** Changes when the folder's git status may have changed. */
    readonly gitRefresh: unknown;
}

/**
 * Message input: a one-line field that grows with its text, with attach and send at its end.
 * Once the text needs a second line the field takes the full width and the buttons move below
 * it. Folder, model, and context sit under the field.
 * @param props Composer props.
 * @param props.state Application state.
 * @param props.slot The current model binding.
 * @param props.running Whether the agent is running; send becomes stop.
 * @param props.modelLocked Whether the model cannot change now.
 * @param props.onSlotChange Apply a new binding.
 * @param props.onSend Send a message.
 * @param props.onStop Stop the running agent.
 * @param props.workspace The chat's folder.
 * @param props.onWorkspaceChange Choose or reset the folder; not while running.
 * @param props.gitRefresh Changes when the folder's git status may have changed.
 * @param props.usage Latest usage.
 * @param props.agentName The agent's name.
 * @returns The composer.
 */
export function Composer({
    state,
    slot,
    running,
    modelLocked,
    onSlotChange,
    onSend,
    onStop,
    workspace,
    onWorkspaceChange,
    usage,
    agentName,
    gitRefresh,
}: ComposerProps) {
    const { t } = useT();
    const [text, setText] = useState('');
    const [sending, setSending] = useState(false);
    const [stacked, setStacked] = useState(false);
    const textarea = useRef<HTMLTextAreaElement>(null);
    const measure = useRef<HTMLSpanElement>(null);
    const choices = modelChoices(state, slot?.credentialId);
    const current = choices.find(choice => choice.card.id === slot?.cardId);
    const placeholder = t('chat.placeholder', { name: agentName });
    const chosen =
        workspace !== undefined && workspace !== state.defaultWorkspace ? workspace : undefined;

    // Measured on a ghost laid out beside the buttons: measuring the textarea itself would flip
    // between layouts, since stacking widens it.
    useLayoutEffect(() => {
        if (measure.current) setStacked(measure.current.scrollHeight > lineHeight);
    }, [text]);

    // Resetting to auto first lets the field shrink again.
    useLayoutEffect(() => {
        const field = textarea.current;
        if (!field) return;
        field.style.height = 'auto';
        field.style.height = `${field.scrollHeight}px`;
    }, [text, stacked]);

    const attachments = useAttachments();
    const fileInput = useRef<HTMLInputElement>(null);
    // An image the current model cannot read blocks sending until removed or the model changes.
    const unreadable = (item: PendingAttachment) =>
        item.staged?.mediaType.startsWith('image/') === true &&
        current !== undefined &&
        !(item.staged.mediaType in current.card.input);
    const blocked = attachments.items.some(item => item.status !== 'ready' || unreadable(item));
    const ready = attachments.items.flatMap(item =>
        item.staged ? [{ sha256: item.staged.sha256, name: item.name }] : []
    );
    const canSend = (text.trim().length > 0 || ready.length > 0) && !blocked;

    const send = async () => {
        const message = text.trim();
        if (!canSend || !current || sending) return;
        setSending(true);
        try {
            await onSend(message, ready);
            setText('');
            attachments.clear();
        } finally {
            setSending(false);
        }
    };

    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-1">
            {/* With a folder, a muted shell concentric with the field carries the folder bar. */}
            <div className={cn('flex flex-col', chosen && 'bg-muted rounded-[32px] p-1')}>
                {chosen && (
                    <WorkspaceBar
                        workspace={chosen}
                        locked={running}
                        refresh={gitRefresh}
                        onChange={onWorkspaceChange}
                    />
                )}
                <form
                    className="bg-background flex w-full flex-col rounded-[28px] border px-2 shadow-xs"
                    onSubmit={event => {
                        event.preventDefault();
                        if (running) onStop();
                        else void send();
                    }}
                    onDragOver={event => {
                        if (event.dataTransfer.types.includes('Files')) event.preventDefault();
                    }}
                    onDrop={event => {
                        if (!event.dataTransfer.files.length) return;
                        event.preventDefault();
                        attachments.add([...event.dataTransfer.files]);
                    }}
                >
                    <input
                        ref={fileInput}
                        type="file"
                        multiple
                        hidden
                        onChange={event => {
                            attachments.add([...(event.currentTarget.files ?? [])]);
                            event.currentTarget.value = '';
                        }}
                    />
                    {attachments.items.length > 0 && (
                        <Attachments variant="inline" className="px-1 pt-3">
                            {attachments.items.map(item => (
                                <PendingChip
                                    key={item.key}
                                    item={item}
                                    unreadable={unreadable(item)}
                                    modelName={current?.card.name ?? ''}
                                    onRemove={() => attachments.remove(item.key)}
                                />
                            ))}
                        </Attachments>
                    )}
                    <div className="relative flex flex-wrap items-end justify-end">
                        <div
                            aria-hidden
                            className="pointer-events-none invisible absolute inset-x-0 top-0 flex h-0 items-start overflow-hidden"
                        >
                            <div className="min-w-0 flex-1">
                                <span
                                    ref={measure}
                                    className="block px-3 text-sm break-words whitespace-pre-wrap"
                                    style={{ lineHeight: `${lineHeight}px` }}
                                >
                                    {text}
                                </span>
                            </div>
                            <div className="flex shrink-0 gap-1">
                                <div className="size-9" />
                                <div className="size-9" />
                            </div>
                        </div>
                        <div className={cn('min-w-0', stacked ? 'basis-full' : 'flex-1')}>
                            <textarea
                                ref={textarea}
                                rows={1}
                                value={text}
                                placeholder={placeholder}
                                aria-label={placeholder}
                                onChange={event => setText(event.currentTarget.value)}
                                onPaste={event => {
                                    const files = [...event.clipboardData.files];
                                    if (files.length === 0) return;
                                    event.preventDefault();
                                    attachments.add(files);
                                }}
                                onKeyDown={event => {
                                    if (
                                        event.key === 'Enter' &&
                                        !event.shiftKey &&
                                        !event.nativeEvent.isComposing
                                    ) {
                                        event.preventDefault();
                                        if (!running) void send();
                                    }
                                }}
                                className="placeholder:text-muted-foreground block w-full resize-none overflow-y-auto border-0 bg-transparent px-3 text-sm outline-none"
                                style={{
                                    lineHeight: `${lineHeight}px`,
                                    paddingTop: paddingY,
                                    paddingBottom: paddingY,
                                    minHeight: collapsedHeight,
                                    maxHeight,
                                }}
                            />
                        </div>
                        <div
                            className="flex shrink-0 items-center gap-1"
                            style={{ height: collapsedHeight }}
                        >
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        aria-label={t('chat.add')}
                                        className="rounded-full"
                                    >
                                        <PlusIcon />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-60">
                                    <DropdownMenuItem onSelect={() => fileInput.current?.click()}>
                                        <PaperclipIcon />
                                        {t('chat.attach')}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        disabled={running}
                                        onSelect={() =>
                                            void chooseDirectory().then(
                                                path => path && onWorkspaceChange(path)
                                            )
                                        }
                                    >
                                        <FolderOpenIcon />
                                        {t('chat.workspace.choose')}
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                            <Button
                                type="submit"
                                size="icon"
                                className="rounded-full"
                                disabled={!running && (!canSend || !current || sending)}
                                aria-label={running ? t('chat.stop') : t('chat.send')}
                            >
                                {running ? (
                                    <SquareIcon className="fill-current" />
                                ) : sending ? (
                                    <Spinner />
                                ) : (
                                    <ArrowUpIcon />
                                )}
                            </Button>
                        </div>
                    </div>
                </form>
            </div>
            <div className="flex items-center gap-0.5 px-2">
                <ModelPicker
                    state={state}
                    choices={choices}
                    slot={slot}
                    locked={modelLocked}
                    onChange={onSlotChange}
                />
                <div className="ml-auto">
                    {current && (
                        <ContextUsage usage={usage} contextWindow={current.card.contextWindow} />
                    )}
                </div>
            </div>
        </div>
    );
}

/**
 * One attachment waiting in the composer: its preview, name, and state.
 * @param props Chip props.
 * @param props.item The attachment.
 * @param props.unreadable Whether the current model cannot read it.
 * @param props.modelName The current model's name.
 * @param props.onRemove Take it out of the message.
 * @returns The chip.
 */
function PendingChip({
    item,
    unreadable,
    modelName,
    onRemove,
}: {
    item: PendingAttachment;
    unreadable: boolean;
    modelName: string;
    onRemove: () => void;
}) {
    const { t } = useT();
    const problem =
        item.status === 'error'
            ? item.error === 'tooLarge'
                ? t('attach.tooLarge')
                : (item.error ?? t('error.generic'))
            : unreadable
              ? t('attach.unreadable', { model: modelName })
              : undefined;
    return (
        <Attachment
            data={{
                id: item.key,
                type: 'file',
                mediaType: item.staged?.mediaType ?? (item.preview ? 'image/*' : 'text/plain'),
                url: item.preview ?? '',
                filename: item.name,
            }}
            onRemove={onRemove}
            title={problem ?? item.name}
            className={cn(
                'rounded-full',
                problem && 'border-destructive/40 bg-destructive/5 text-destructive'
            )}
        >
            {item.status === 'staging' ? <Spinner className="size-3.5" /> : <AttachmentPreview />}
            <AttachmentInfo className="max-w-40" />
            <AttachmentRemove label={t('attach.remove')} />
        </Attachment>
    );
}
