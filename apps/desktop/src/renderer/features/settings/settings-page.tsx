import { LanguagesIcon } from 'lucide-react';

import { ChoiceMenu } from '../../components/choice-menu';
import { call } from '../../lib/client';
import { useT } from '../../lib/i18n';
import { useAction } from '../../lib/use-action';

import type { AppState } from '../../../shared/ipc';

import { Card, CardContent } from '@/components/ui/card';
import {
    Field,
    FieldContent,
    FieldDescription,
    FieldGroup,
    FieldLabel,
} from '@/components/ui/field';
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
    const resume = useAction((enabled: boolean) =>
        call('settings.resumeAfterRestart', { enabled })
    );
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
                            <ChoiceMenu
                                id="language"
                                value={state.locale}
                                choices={languages}
                                icon={<LanguagesIcon />}
                                placeholder={t('settings.language')}
                                className="w-44"
                                align="end"
                                onChange={locale => call('settings.locale', { locale })}
                            />
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
                                disabled={resume.pending}
                                aria-busy={resume.pending || undefined}
                                onCheckedChange={enabled => void resume.run(enabled)}
                            />
                        </Field>
                    </FieldGroup>
                </CardContent>
            </Card>
        </div>
    );
}
