import { BoxesIcon, LanguagesIcon, PuzzleIcon, SlidersHorizontalIcon } from 'lucide-react';

import { ChoiceMenu } from '../../components/choice-menu';
import { call } from '../../lib/client';
import { useT } from '../../lib/i18n';
import { useAction } from '../../lib/use-action';
import { ModelSettings } from '../models/models-page';
import { PluginSettings } from '../plugins/plugins-page';

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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const languages = [
    { value: 'en', label: 'English' },
    { value: 'zh-CN', label: '简体中文' },
] as const;

export type SettingsTab = 'general' | 'models' | 'plugins';

const tabs = [
    { id: 'general', label: 'settings.general', icon: SlidersHorizontalIcon },
    { id: 'models', label: 'nav.models', icon: BoxesIcon },
    { id: 'plugins', label: 'nav.plugins', icon: PuzzleIcon },
] as const;

/**
 * The Settings page: general preferences, models, and plugins.
 * @param props Page props.
 * @param props.state Application state.
 * @param props.tab The open tab.
 * @param props.onTabChange Switch tabs.
 * @returns The page.
 */
export function SettingsPage({
    state,
    tab,
    onTabChange,
}: {
    state: AppState;
    tab: SettingsTab;
    onTabChange: (tab: SettingsTab) => void;
}) {
    const { t } = useT();
    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-8">
            <h1 className="text-2xl font-semibold tracking-tight">{t('settings.title')}</h1>
            <Tabs
                value={tab}
                onValueChange={value => {
                    const next = tabs.find(item => item.id === value);
                    if (next) onTabChange(next.id);
                }}
                className="gap-6"
            >
                <TabsList>
                    {tabs.map(item => (
                        <TabsTrigger key={item.id} value={item.id}>
                            <item.icon /> {t(item.label)}
                        </TabsTrigger>
                    ))}
                </TabsList>
                <TabsContent value="general">
                    <GeneralSettings state={state} />
                </TabsContent>
                <TabsContent value="models">
                    <ModelSettings state={state} />
                </TabsContent>
                <TabsContent value="plugins">
                    <PluginSettings state={state} />
                </TabsContent>
            </Tabs>
        </div>
    );
}

/**
 * General preferences: language and agent behavior.
 * @param props Application state.
 * @param props.state Application state.
 * @returns The section.
 */
function GeneralSettings({ state }: { state: AppState }) {
    const { t } = useT();
    const resume = useAction((enabled: boolean) =>
        call('settings.resumeAfterRestart', { enabled })
    );
    return (
        <Card>
            <CardContent>
                <FieldGroup>
                    <Field orientation="horizontal">
                        <FieldContent>
                            <FieldLabel htmlFor="language">{t('settings.language')}</FieldLabel>
                            <FieldDescription>{t('settings.languageDescription')}</FieldDescription>
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
                            <FieldDescription>{t('settings.resumeDescription')}</FieldDescription>
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
    );
}
