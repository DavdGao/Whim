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
import { ScrollArea } from '@whimkit/ui/components/scroll-area';
import { Switch } from '@whimkit/ui/components/switch';
import { cn } from '@whimkit/ui/lib/utils';
import {
    BotIcon,
    BoxesIcon,
    BoxIcon,
    LanguagesIcon,
    ShieldCheckIcon,
    UserRoundIcon,
    PuzzleIcon,
    SaveIcon,
    PaletteIcon,
    ServerIcon,
    SlidersHorizontalIcon,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { ActionButton } from '../../components/action-button';
import { ChoiceMenu } from '../../components/choice-menu';
import { EntityIcon } from '../../components/entity-icon';
import { call } from '../../lib/client';
import { useT } from '../../lib/i18n';
import { modelIcon } from '../../lib/icons';
import { pluginText } from '../../lib/messages';
import { useAction } from '../../lib/use-action';
import { reviewerChoices } from '../chat/model-choices';
import { ModelSettings } from '../models/models-page';
import { PluginSettings } from '../plugins/plugins-page';

import { AgentSettings } from './agent-settings';
import { McpSettings } from './mcp-settings';

import type { AppState } from '../../../shared/ipc';
import type { PageProps, SettingsSectionEntry } from '../../lib/navigation';

/** The default look's choice value; theme ids always contain `#`. */
const defaultTheme = 'default';

const languages = [
    { value: 'en', label: 'English' },
    { value: 'zh-CN', label: '简体中文' },
] as const;

const sections: readonly SettingsSectionEntry[] = [
    {
        id: 'general',
        title: 'settings.general',
        icon: SlidersHorizontalIcon,
        // Remount after a save so the name field shows the stored value.
        component: ({ state }) => <GeneralSettings key={state.userName ?? ''} state={state} />,
    },
    {
        id: 'agent',
        title: 'settings.agent',
        icon: BotIcon,
        // Remount after a save or reset so the form shows the stored profile.
        component: ({ state }) => <AgentSettings key={JSON.stringify(state.agent)} state={state} />,
    },
    { id: 'models', title: 'nav.models', icon: BoxesIcon, component: ModelSettings },
    { id: 'plugins', title: 'nav.plugins', icon: PuzzleIcon, component: PluginSettings },
    { id: 'mcp', title: 'settings.mcp', icon: ServerIcon, component: McpSettings },
];

/**
 * The Settings page: a section list on the left and the open section on the right. The
 * `section` parameter selects the section.
 * @param props Page props.
 * @param props.state Application state.
 * @param props.params Navigation parameters.
 * @param props.navigate Navigate, here to another section.
 * @returns The page.
 */
export function SettingsPage({ state, params, navigate }: PageProps) {
    const { t } = useT();
    const current = sections.find(item => item.id === params.section) ?? sections[0];
    if (!current) return null;
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
                            item === current && 'bg-accent text-accent-foreground'
                        )}
                        aria-current={item === current ? 'page' : undefined}
                        onClick={() => navigate('settings', { section: item.id })}
                    >
                        <item.icon />
                        {t(item.title)}
                    </Button>
                ))}
            </nav>
            <ScrollArea className="min-h-0 flex-1">
                <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-8">
                    <h2 className="text-2xl font-semibold tracking-tight">{t(current.title)}</h2>
                    <current.component state={state} />
                </div>
            </ScrollArea>
        </div>
    );
}

/**
 * General preferences: language, what agents call the user, and agent behavior.
 * The name is in every agent's system prompt, so like the agent profile it reaches existing
 * chats at their next model switch or compaction.
 * @param props Application state.
 * @param props.state Application state.
 * @returns The section.
 */
function GeneralSettings({ state }: { state: AppState }) {
    const { t, locale } = useT();
    const resume = useAction((enabled: boolean) =>
        call('settings.resumeAfterRestart', { enabled })
    );
    const [userName, setUserName] = useState(state.userName ?? '');
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
                            <FieldLabel htmlFor="theme">{t('settings.theme')}</FieldLabel>
                            <FieldDescription>{t('settings.themeDescription')}</FieldDescription>
                        </FieldContent>
                        <ChoiceMenu
                            id="theme"
                            value={state.theme ?? defaultTheme}
                            choices={[
                                { value: defaultTheme, label: t('settings.theme.default') },
                                ...state.themes.map(theme => ({
                                    value: theme.id,
                                    label: pluginText(
                                        state.plugins.find(plugin => plugin.id === theme.pluginId)
                                            ?.locales,
                                        locale,
                                        theme.name,
                                        theme.name
                                    ),
                                })),
                            ]}
                            icon={<PaletteIcon />}
                            placeholder={t('settings.theme')}
                            className="w-44"
                            align="end"
                            onChange={theme =>
                                call('settings.theme', {
                                    theme: theme === defaultTheme ? null : theme,
                                })
                            }
                        />
                    </Field>
                    <Field orientation="horizontal">
                        <FieldContent>
                            <FieldLabel htmlFor="user-name">{t('settings.userName')}</FieldLabel>
                            <FieldDescription>{t('settings.userNameDescription')}</FieldDescription>
                        </FieldContent>
                        <div className="flex items-center gap-2">
                            <Input
                                id="user-name"
                                value={userName}
                                maxLength={60}
                                className="w-44"
                                placeholder={t('settings.userNamePlaceholder')}
                                onChange={event => setUserName(event.currentTarget.value)}
                            />
                            <ActionButton
                                size="sm"
                                icon={<SaveIcon />}
                                disabled={userName.trim() === (state.userName ?? '')}
                                action={async () => {
                                    await call('settings.userName', {
                                        name: userName.trim() || null,
                                    });
                                    toast.success(t('settings.userNameSaved'));
                                }}
                            >
                                {t('common.save')}
                            </ActionButton>
                        </div>
                    </Field>
                    <PermissionSettings state={state} />
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

/**
 * How tool calls that need permission are answered: by the user, or by a reviewer model first.
 * @param props Application state.
 * @param props.state Application state.
 * @returns The fields.
 */
function PermissionSettings({ state }: { state: AppState }) {
    const { t } = useT();
    const { permissions } = state;
    const choices = reviewerChoices(state, permissions.reviewer?.credentialId);
    const reviewer =
        choices.find(choice => choice.card.id === permissions.reviewer?.cardId) ?? choices[0];
    return (
        <>
            <Field orientation="horizontal">
                <FieldContent>
                    <FieldLabel htmlFor="permission-mode">{t('settings.permissions')}</FieldLabel>
                    <FieldDescription>{t('settings.permissionsDescription')}</FieldDescription>
                </FieldContent>
                <ChoiceMenu
                    id="permission-mode"
                    value={permissions.mode}
                    choices={[
                        {
                            value: 'manual',
                            label: t('settings.permissions.manual'),
                            icon: <UserRoundIcon />,
                        },
                        {
                            value: 'auto',
                            label: t('settings.permissions.auto'),
                            icon: <ShieldCheckIcon />,
                        },
                    ]}
                    icon={<ShieldCheckIcon />}
                    placeholder={t('settings.permissions')}
                    className="w-56"
                    align="end"
                    onChange={mode =>
                        call('settings.permissions', {
                            permissions: {
                                mode,
                                ...(reviewer
                                    ? {
                                          reviewer: {
                                              cardId: reviewer.card.id,
                                              credentialId: reviewer.credentialId,
                                          },
                                      }
                                    : {}),
                            },
                        })
                    }
                />
            </Field>
            {permissions.mode === 'auto' && (
                <Field orientation="horizontal">
                    <FieldContent>
                        <FieldLabel htmlFor="reviewer">{t('settings.reviewer')}</FieldLabel>
                        <FieldDescription>{t('settings.reviewerDescription')}</FieldDescription>
                    </FieldContent>
                    <ChoiceMenu
                        id="reviewer"
                        value={permissions.reviewer?.cardId}
                        disabled={choices.length === 0}
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
                        className="w-56"
                        align="end"
                        onChange={cardId => {
                            const choice = choices.find(item => item.card.id === cardId);
                            return choice
                                ? call('settings.permissions', {
                                      permissions: {
                                          mode: 'auto',
                                          reviewer: { cardId, credentialId: choice.credentialId },
                                      },
                                  })
                                : undefined;
                        }}
                    />
                </Field>
            )}
        </>
    );
}
