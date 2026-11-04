import { PuzzleIcon } from 'lucide-react';

import { call } from '../../lib/client';
import { useT } from '../../lib/i18n';
import { pluginText } from '../../lib/messages';

import type { AppState } from '../../../shared/ipc';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

const availabilityKeys = {
    active: 'plugins.availability.active',
    disabled: 'plugins.availability.disabled',
    failed: 'plugins.availability.failed',
    modified: 'plugins.availability.modified',
    'missing-dependency': 'plugins.availability.missing-dependency',
} as const;

/**
 * The Plugins page: installation, version, availability, and desired activation.
 * @param props Application state.
 * @param props.state Application state.
 * @returns The page.
 */
export function PluginsPage({ state }: { state: AppState }) {
    const { t, locale } = useT();
    const dates = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-8">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight">{t('plugins.title')}</h1>
                <p className="text-muted-foreground mt-1 text-sm">{t('plugins.description')}</p>
            </header>
            {state.plugins.map(plugin => {
                const key = availabilityKeys[plugin.availability as keyof typeof availabilityKeys];
                const switchId = `plugin-${plugin.id}`;
                return (
                    <Card key={plugin.id}>
                        <CardContent className="flex items-start gap-4">
                            <div className="bg-muted rounded-lg p-2">
                                <PuzzleIcon className="size-5" />
                            </div>
                            <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                    <p className="font-medium">
                                        {pluginText(
                                            plugin.locales,
                                            locale,
                                            'plugin.name',
                                            plugin.id
                                        )}
                                    </p>
                                    <Badge
                                        variant={
                                            plugin.availability === 'active'
                                                ? 'secondary'
                                                : 'destructive'
                                        }
                                    >
                                        {key ? t(key) : plugin.availability}
                                    </Badge>
                                    <Badge variant="outline">
                                        {plugin.source === 'bundled'
                                            ? t('plugins.bundled')
                                            : t('plugins.local')}
                                    </Badge>
                                </div>
                                <p className="text-muted-foreground mt-1 text-sm">
                                    {pluginText(plugin.locales, locale, 'plugin.description', '')}
                                </p>
                                <p className="text-muted-foreground mt-2 text-xs">
                                    <code>{plugin.id}</code> ·{' '}
                                    {t('plugins.version', { version: plugin.version })}
                                    {plugin.installedAt
                                        ? ` · ${t('plugins.installed', { date: dates.format(new Date(plugin.installedAt)) })}`
                                        : ''}
                                </p>
                                {plugin.error && (
                                    <p className="text-destructive mt-2 text-xs break-all">
                                        {plugin.error}
                                    </p>
                                )}
                            </div>
                            <div className="flex flex-col items-end gap-1">
                                <div className="flex items-center gap-2">
                                    <Label htmlFor={switchId}>{t('plugins.enabled')}</Label>
                                    <Switch
                                        id={switchId}
                                        checked={plugin.enabled}
                                        onCheckedChange={enabled =>
                                            void call('plugins.setEnabled', {
                                                id: plugin.id,
                                                enabled,
                                            })
                                        }
                                    />
                                </div>
                                {((plugin.enabled && plugin.availability === 'disabled') ||
                                    (!plugin.enabled && plugin.availability === 'active')) && (
                                    <p className="text-muted-foreground text-xs">
                                        {t('plugins.restart')}
                                    </p>
                                )}
                            </div>
                        </CardContent>
                    </Card>
                );
            })}
        </div>
    );
}
