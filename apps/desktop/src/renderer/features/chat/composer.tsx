import { ArrowUpIcon, PaperclipIcon, SquareIcon } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';

import { useT } from '../../lib/i18n';

import { ContextUsage } from './context-usage';
import { modelChoices } from './model-choices';
import { ModelPicker } from './model-picker';
import { WorkspacePicker } from './workspace-picker';

import type { AppState, ChatSlot } from '../../../shared/ipc';
import type { Usage } from '@whimkit/core/contracts';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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
    readonly onSend: (text: string) => Promise<void>;
    readonly onStop: () => void;
    readonly workspace: string | undefined;
    /** The latest reported usage, for the context indicator. */
    readonly usage: Usage | undefined;
    /** The agent's display name, used in the placeholder. */
    readonly agentName: string;
    /** Absent once the chat exists: the folder is fixed for its life. */
    readonly onWorkspaceChange?: (workspace: string | undefined) => void;
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
 * @param props.onWorkspaceChange Change the folder before the chat starts.
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

    const send = async () => {
        const message = text.trim();
        if (!message || !current || sending) return;
        setSending(true);
        try {
            await onSend(message);
            setText('');
        } finally {
            setSending(false);
        }
    };

    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-1">
            <form
                className="bg-background flex w-full flex-col rounded-[28px] border px-2 shadow-xs"
                onSubmit={event => {
                    event.preventDefault();
                    if (running) onStop();
                    else void send();
                }}
            >
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
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <span tabIndex={0} className="inline-flex rounded-full">
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        disabled
                                        aria-label={t('chat.attach')}
                                        className="rounded-full"
                                    >
                                        <PaperclipIcon />
                                    </Button>
                                </span>
                            </TooltipTrigger>
                            <TooltipContent>{t('chat.attachSoon')}</TooltipContent>
                        </Tooltip>
                        <Button
                            type="submit"
                            size="icon"
                            className="rounded-full"
                            disabled={!running && (!text.trim() || !current || sending)}
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
            <div className="flex items-center gap-0.5 px-2">
                <WorkspacePicker
                    workspace={workspace}
                    fallback={state.defaultWorkspace}
                    {...(onWorkspaceChange ? { onChange: onWorkspaceChange } : {})}
                />
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
