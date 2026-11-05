import { useState } from 'react';

import { useT } from '../../lib/i18n';

import { ContextUsage } from './context-usage';
import { modelChoices } from './model-choices';
import { ModelPicker } from './model-picker';
import { WorkspacePicker } from './workspace-picker';

import type { AppState, ChatSlot } from '../../../shared/ipc';
import type { Usage } from '@whimkit/core/contracts';

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
    /** The latest reported usage, for the context indicator. */
    readonly usage: Usage | undefined;
    /** The agent's display name, used in the placeholder. */
    readonly agentName: string;
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
 * @param props.usage
 * @param props.agentName
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
    const choices = modelChoices(state, slot?.credentialId);
    const current = choices.find(choice => choice.card.id === slot?.cardId);

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
                    placeholder={t('chat.placeholder', { name: agentName })}
                    aria-label={t('chat.placeholder', { name: agentName })}
                />
            </PromptInputBody>
            <PromptInputFooter>
                <PromptInputTools>
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
                </PromptInputTools>
                <div className="flex items-center gap-1">
                    {current && (
                        <ContextUsage usage={usage} contextWindow={current.card.contextWindow} />
                    )}
                    <PromptInputSubmit
                        className="rounded-full"
                        status={running ? 'streaming' : sending ? 'submitted' : undefined}
                        disabled={!running && (!text.trim() || !current || sending)}
                        aria-label={running ? t('chat.stop') : t('chat.send')}
                    />
                </div>
            </PromptInputFooter>
        </PromptInput>
    );
}
