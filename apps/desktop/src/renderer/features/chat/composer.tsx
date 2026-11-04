import { selectableLevels } from '@whimkit/core/contracts';
import { useState } from 'react';

import { useT } from '../../lib/i18n';

import { modelChoices } from './model-choices';

import type { AppState, ChatSlot } from '../../../shared/ipc';

import {
    PromptInput,
    PromptInputBody,
    PromptInputFooter,
    PromptInputSelect,
    PromptInputSelectContent,
    PromptInputSelectItem,
    PromptInputSelectTrigger,
    PromptInputSelectValue,
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
    readonly onSlotChange: (slot: ChatSlot) => void;
    readonly onSend: (text: string) => Promise<void>;
    readonly onStop: () => void;
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
                    <PromptInputSelect
                        value={current?.card.id ?? ''}
                        disabled={modelLocked}
                        onValueChange={cardId => {
                            const choice = choices.find(item => item.card.id === cardId);
                            if (choice) onSlotChange({ cardId, credentialId: choice.credentialId });
                        }}
                    >
                        <PromptInputSelectTrigger
                            aria-label={t('chat.model')}
                            title={modelLocked ? t('chat.modelLocked') : undefined}
                        >
                            <PromptInputSelectValue placeholder={t('chat.model')} />
                        </PromptInputSelectTrigger>
                        <PromptInputSelectContent>
                            {choices.map(choice => (
                                <PromptInputSelectItem key={choice.card.id} value={choice.card.id}>
                                    {choice.card.name}
                                </PromptInputSelectItem>
                            ))}
                        </PromptInputSelectContent>
                    </PromptInputSelect>
                    {fixed ? (
                        <span className="text-muted-foreground px-2 text-xs">
                            {t('chat.thinking.fixed')}
                        </span>
                    ) : levels.length > 0 && slot ? (
                        <PromptInputSelect
                            value={level ?? ''}
                            onValueChange={value => {
                                const thinking = levels.find(item => item === value);
                                if (thinking) onSlotChange({ ...slot, thinking });
                            }}
                        >
                            <PromptInputSelectTrigger aria-label={t('chat.thinking')}>
                                <PromptInputSelectValue placeholder={t('chat.thinking')} />
                            </PromptInputSelectTrigger>
                            <PromptInputSelectContent>
                                {levels.map(item => (
                                    <PromptInputSelectItem key={item} value={item}>
                                        {t('chat.thinking')}: {t(`level.${item}`)}
                                    </PromptInputSelectItem>
                                ))}
                            </PromptInputSelectContent>
                        </PromptInputSelect>
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
