import { selectableLevels } from '@whimkit/core/contracts';
import { BoxIcon, BrainIcon } from 'lucide-react';
import { useState } from 'react';

import { ChoiceMenu } from '../../components/choice-menu';
import { EntityIcon } from '../../components/entity-icon';
import { useT } from '../../lib/i18n';
import { modelIcon } from '../../lib/icons';

import { modelChoices } from './model-choices';
import { WorkspacePicker } from './workspace-picker';

import type { AppState, ChatSlot } from '../../../shared/ipc';

import {
    PromptInput,
    PromptInputBody,
    PromptInputFooter,
    PromptInputSubmit,
    PromptInputTextarea,
    PromptInputTools,
} from '@/components/ai-elements/prompt-input';

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
    /** Absent once the chat exists: the folder is fixed for its life. */
    readonly onWorkspaceChange?: (workspace: string | undefined) => void;
}

/**
 * Message input with model and thinking selectors; the submit button stops a running agent.
 * @param props Composer props.
 * @param props.state
 * @param props.slot
 * @param props.running
 * @param props.modelLocked
 * @param props.onSlotChange
 * @param props.onSend
 * @param props.onStop
 * @param props.workspace
 * @param props.onWorkspaceChange
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
}: ComposerProps) {
    const { t } = useT();
    const [text, setText] = useState('');
    const [sending, setSending] = useState(false);
    const choices = modelChoices(state, slot?.credentialId);
    const current = choices.find(choice => choice.card.id === slot?.cardId);
    const levels = current ? selectableLevels(current.card.thinking) : [];
    const fixed = current?.card.thinking && 'fixed' in current.card.thinking;
    const level =
        slot?.thinking && levels.includes(slot.thinking)
            ? slot.thinking
            : current?.card.thinking && 'default' in current.card.thinking
              ? current.card.thinking.default
              : undefined;

    const submit = async () => {
        if (running) {
            onStop();
            return;
        }
        const message = text.trim();
        if (!message || !current) return;
        setSending(true);
        try {
            await onSend(message);
            setText('');
        } finally {
            setSending(false);
        }
    };

    return (
        <PromptInput onSubmit={() => void submit()} className="mx-auto w-full max-w-3xl">
            <PromptInputBody>
                <PromptInputTextarea
                    value={text}
                    onChange={event => setText(event.currentTarget.value)}
                    placeholder={t('chat.placeholder')}
                    aria-label={t('chat.placeholder')}
                />
            </PromptInputBody>
            <PromptInputFooter>
                <PromptInputTools>
                    <WorkspacePicker
                        workspace={workspace}
                        {...(onWorkspaceChange ? { onChange: onWorkspaceChange } : {})}
                    />
                    <ChoiceMenu
                        value={current?.card.id}
                        choices={choices.map(choice => ({
                            value: choice.card.id,
                            label: choice.card.name,
                            group: choice.provider,
                            icon: (
                                <EntityIcon
                                    src={modelIcon(state, choice.card)}
                                    fallback={BoxIcon}
                                />
                            ),
                        }))}
                        icon={<BoxIcon />}
                        placeholder={t('chat.model')}
                        aria-label={t('chat.model')}
                        disabled={modelLocked}
                        {...(modelLocked ? { title: t('chat.modelLocked') } : {})}
                        variant="ghost"
                        size="sm"
                        onChange={cardId => {
                            const choice = choices.find(item => item.card.id === cardId);
                            return choice
                                ? onSlotChange({ cardId, credentialId: choice.credentialId })
                                : undefined;
                        }}
                    />
                    {fixed ? (
                        <span className="text-muted-foreground flex items-center gap-1.5 px-2 text-xs">
                            <BrainIcon className="size-3.5" />
                            {t('chat.thinking.fixed')}
                        </span>
                    ) : levels.length > 0 && slot ? (
                        <ChoiceMenu
                            value={level}
                            choices={levels.map(item => ({
                                value: item,
                                label: `${t('chat.thinking')}: ${t(`level.${item}`)}`,
                            }))}
                            icon={<BrainIcon />}
                            placeholder={t('chat.thinking')}
                            aria-label={t('chat.thinking')}
                            variant="ghost"
                            size="sm"
                            onChange={thinking => onSlotChange({ ...slot, thinking })}
                        />
                    ) : null}
                </PromptInputTools>
                <PromptInputSubmit
                    status={running ? 'streaming' : sending ? 'submitted' : undefined}
                    disabled={!running && (!text.trim() || !current || sending)}
                    aria-label={running ? t('chat.stop') : t('chat.send')}
                />
            </PromptInputFooter>
        </PromptInput>
    );
}
