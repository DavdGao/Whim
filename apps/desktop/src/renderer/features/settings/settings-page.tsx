import { BotIcon, BoxesIcon, LanguagesIcon, PuzzleIcon, SlidersHorizontalIcon } from 'lucide-react';

import { ChoiceMenu } from '../../components/choice-menu';
import { call } from '../../lib/client';
import { useT } from '../../lib/i18n';
import { useAction } from '../../lib/use-action';
import { ModelSettings } from '../models/models-page';
import { PluginSettings } from '../plugins/plugins-page';

import { AgentSettings } from './agent-settings';

import type { AppState } from '../../../shared/ipc';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
    Field,
    FieldContent,
    FieldDescription,
    FieldGroup,
    FieldLabel,
} from '@/components/ui/field';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

const languages = [
    { value: 'en', label: 'English' },
    { value: 'zh-CN', label: '简体中文' },
] as const;

export type SettingsTab = 'general' | 'agent' | 'models' | 'plugins';

const sections = [
    { id: 'general', label: 'settings.general', icon: SlidersHorizontalIcon },
    { id: 'agent', label: 'settings.agent', icon: BotIcon },
    { id: 'models', label: 'nav.models', icon: BoxesIcon },
    { id: 'plugins', label: 'nav.plugins', icon: PuzzleIcon },
] as const;

/**
 * The Settings page: a section list on the left and the open section on the right.
 * @param props Page props.
 * @param props.state Application state.
 * @param props.tab The open section.
 * @param props.onTabChange Switch sections.
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
    const current = sections.find(item => item.id === tab) ?? sections[0];
    return (
        <div className="flex h-full min-h-0">
            <nav
                className="bg-muted/30 flex w-56 shrink-0 flex-col gap-1 border-r p-3"
                aria-label={t('settings.title')}
            >
                <h1 className="px-3 pt-1 pb-3 text-lg font-semibold tracking-tight">
                    {t('settings.title')}
                </h1>
                {sections.map(item => (
                    <Button
                        key={item.id}
                        variant="ghost"
                        className={cn(
                            'h-9 justify-start gap-2.5 rounded-xl px-3',
                            item.id === tab && 'bg-accent text-accent-foreground'
                        )}
                        aria-current={item.id === tab ? 'page' : undefined}
                        onClick={() => onTabChange(item.id)}
                    >
                        <item.icon />
                        {t(item.label)}
                    </Button>
                ))}
            </nav>
            <ScrollArea className="min-h-0 flex-1">
                <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-8">
                    <h2 className="text-2xl font-semibold tracking-tight">{t(current.label)}</h2>
                    {tab === 'general' && <GeneralSettings state={state} />}
                    {tab === 'agent' && (
                        // Remount after a save or reset so the form shows the stored profile.
                        <AgentSettings key={JSON.stringify(state.agent)} state={state} />
                    )}
                    {tab === 'models' && <ModelSettings state={state} />}
                    {tab === 'plugins' && <PluginSettings state={state} />}
                </div>
            </ScrollArea>
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
