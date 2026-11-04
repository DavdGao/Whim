import { call } from '../../lib/client';
import { useT } from '../../lib/i18n';

import type { AppState } from '../../../shared/ipc';

import { Card, CardContent } from '@/components/ui/card';
import {
    Field,
    FieldContent,
    FieldDescription,
    FieldGroup,
    FieldLabel,
} from '@/components/ui/field';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

const languages = [
    { value: 'en', label: 'English' },
    { value: 'zh-CN', label: '简体中文' },
] as const;

/**
 * The Settings page: language and agent behavior.
 * @param props Application state.
 * @param props.state Application state.
 * @returns The page.
 */
export function SettingsPage({ state }: { state: AppState }) {
    const { t } = useT();
    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-8">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight">{t('settings.title')}</h1>
            </header>
            <Card>
                <CardContent>
                    <FieldGroup>
                        <Field orientation="horizontal">
                            <FieldContent>
                                <FieldLabel htmlFor="language">{t('settings.language')}</FieldLabel>
                                <FieldDescription>
                                    {t('settings.languageDescription')}
                                </FieldDescription>
                            </FieldContent>
                            <Select
                                value={state.locale}
                                onValueChange={value => {
                                    const language = languages.find(item => item.value === value);
                                    if (language)
                                        void call('settings.locale', { locale: language.value });
                                }}
                            >
                                <SelectTrigger id="language" className="w-40">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {languages.map(language => (
                                        <SelectItem key={language.value} value={language.value}>
                                            {language.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </Field>
                        <Field orientation="horizontal">
                            <FieldContent>
                                <FieldLabel htmlFor="resume">{t('settings.resume')}</FieldLabel>
                                <FieldDescription>
                                    {t('settings.resumeDescription')}
                                </FieldDescription>
                            </FieldContent>
                            <Switch
                                id="resume"
                                checked={state.resumeAfterRestart}
                                onCheckedChange={enabled =>
                                    void call('settings.resumeAfterRestart', { enabled })
                                }
                            />
                        </Field>
                    </FieldGroup>
                </CardContent>
            </Card>
        </div>
    );
}
