import { Button } from '@whimkit/ui/components/button';
import { Card, CardContent } from '@whimkit/ui/components/card';
import {
    Field,
    FieldContent,
    FieldDescription,
    FieldGroup,
    FieldLabel,
} from '@whimkit/ui/components/field';
import { Input } from '@whimkit/ui/components/input';
import { Textarea } from '@whimkit/ui/components/textarea';
import { ImageUpIcon, RotateCcwIcon, SaveIcon, Trash2Icon } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

import { ActionButton } from '../../components/action-button';
import { AgentAvatar } from '../../components/agent-avatar';
import { call } from '../../lib/client';
import { useT } from '../../lib/i18n';

import type { AgentProfile, AppState } from '../../../shared/ipc';

const maxIconBytes = 200 * 1024;

/**
 * Read an image file as a data URL.
 * @param file The chosen file.
 * @returns The data URL.
 */
function readDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () =>
            typeof reader.result === 'string'
                ? resolve(reader.result)
                : reject(new Error('Unreadable image.'));
        reader.onerror = () => reject(reader.error ?? new Error('Unreadable image.'));
        reader.readAsDataURL(file);
    });
}

/**
 * The agent's name, icon, and system prompt. Changes apply to chats started afterwards and
 * to existing chats at their next model switch or compaction.
 * @param props Application state.
 * @param props.state Application state.
 * @returns The section.
 */
export function AgentSettings({ state }: { state: AppState }) {
    const { t } = useT();
    const [name, setName] = useState(state.agent.name);
    const [prompt, setPrompt] = useState(state.agent.systemPrompt);
    const [icon, setIcon] = useState(state.agent.icon);
    const input = useRef<HTMLInputElement>(null);
    const profile = (): AgentProfile => ({
        name: name.trim(),
        systemPrompt: prompt.trim(),
        ...(icon ? { icon } : {}),
    });
    const changed =
        name !== state.agent.name ||
        prompt !== state.agent.systemPrompt ||
        icon !== state.agent.icon;

    return (
        <div className="flex flex-col gap-4">
            <p className="text-muted-foreground text-sm">{t('agent.description')}</p>
            <Card>
                <CardContent>
                    <FieldGroup>
                        <Field orientation="horizontal">
                            <FieldContent>
                                <FieldLabel>{t('agent.icon')}</FieldLabel>
                                <FieldDescription>{t('agent.iconDescription')}</FieldDescription>
                            </FieldContent>
                            <div className="flex items-center gap-2">
                                <AgentAvatar icon={icon} className="size-12 rounded-2xl" />
                                <input
                                    ref={input}
                                    type="file"
                                    accept="image/png,image/jpeg,image/webp,image/svg+xml"
                                    className="hidden"
                                    onChange={event => {
                                        const file = event.currentTarget.files?.[0];
                                        event.currentTarget.value = '';
                                        if (!file) return;
                                        if (file.size > maxIconBytes) {
                                            toast.error(t('agent.iconTooLarge'));
                                            return;
                                        }
                                        void readDataUrl(file).then(setIcon, () =>
                                            toast.error(t('error.generic'))
                                        );
                                    }}
                                />
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => input.current?.click()}
                                >
                                    <ImageUpIcon /> {t('agent.iconChoose')}
                                </Button>
                                {icon && (
                                    <Button
                                        variant="ghost"
                                        size="icon-sm"
                                        aria-label={t('agent.iconRemove')}
                                        onClick={() => setIcon(undefined)}
                                    >
                                        <Trash2Icon />
                                    </Button>
                                )}
                            </div>
                        </Field>
                        <Field>
                            <FieldLabel htmlFor="agent-name">{t('agent.name')}</FieldLabel>
                            <Input
                                id="agent-name"
                                value={name}
                                maxLength={60}
                                onChange={event => setName(event.currentTarget.value)}
                            />
                        </Field>
                        <Field>
                            <FieldLabel htmlFor="agent-prompt">{t('agent.prompt')}</FieldLabel>
                            <Textarea
                                id="agent-prompt"
                                value={prompt}
                                rows={10}
                                className="max-h-96 font-mono text-xs"
                                onChange={event => setPrompt(event.currentTarget.value)}
                            />
                            <FieldDescription>{t('agent.promptDescription')}</FieldDescription>
                        </Field>
                    </FieldGroup>
                </CardContent>
            </Card>
            <div className="flex justify-end gap-2">
                {!state.agent.isDefault && (
                    <ActionButton
                        variant="ghost"
                        icon={<RotateCcwIcon />}
                        action={() => call('settings.agent', { profile: null })}
                    >
                        {t('agent.reset')}
                    </ActionButton>
                )}
                <ActionButton
                    icon={<SaveIcon />}
                    disabled={!changed || !name.trim() || !prompt.trim()}
                    action={async () => {
                        await call('settings.agent', { profile: profile() });
                        toast.success(t('agent.saved'));
                    }}
                >
                    {t('common.save')}
                </ActionButton>
            </div>
        </div>
    );
}
