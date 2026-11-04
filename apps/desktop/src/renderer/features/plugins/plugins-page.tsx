import { PuzzleIcon } from 'lucide-react';

import { EntityIcon } from '../../components/entity-icon';
import { call } from '../../lib/client';
import { useT } from '../../lib/i18n';
import { pluginText } from '../../lib/messages';
import { useAction } from '../../lib/use-action';

import type { AppState } from '../../../shared/ipc';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

const categories = ['models', 'tools', 'other'] as const;

const availabilityKeys = {
    active: 'plugins.availability.active',
    disabled: 'plugins.availability.disabled',
    failed: 'plugins.availability.failed',
    modified: 'plugins.availability.modified',
    'missing-dependency': 'plugins.availability.missing-dependency',
} as const;

/**
 * The desired-activation switch of one plugin, disabled while the change is saved.
 * @param props Switch props.
 * @param props.id The element id.
 * @param props.pluginId The plugin.
 * @param props.enabled Desired activation.
 * @returns The switch.
 */
function PluginSwitch({
    id,
    pluginId,
    enabled,
}: {
    id: string;
    pluginId: string;
    enabled: boolean;
}) {
    const toggle = useAction((next: boolean) =>
        call('plugins.setEnabled', { id: pluginId, enabled: next })
    );
    return (
        <Switch
            id={id}
            checked={enabled}
            disabled={toggle.pending}
            aria-busy={toggle.pending || undefined}
            onCheckedChange={next => void toggle.run(next)}
        />
    );
}

/**
 * Plugin settings: installation, version, availability, and desired activation.
 * @param props Application state.
 * @param props.state Application state.
 * @returns The section.
 */
export function PluginSettings({ state }: { state: AppState }) {
    const { t, locale } = useT();
    const dates = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
    return (
        <div className="flex flex-col gap-6">
            <p className="text-muted-foreground text-sm">{t('plugins.description')}</p>
            {categories.map(category => {
                const plugins = state.plugins.filter(plugin => plugin.category === category);
                if (plugins.length === 0) return null;
                return (
                    <section key={category} className="flex flex-col gap-3">
                        <h3 className="text-muted-foreground text-sm font-medium">
                            {t(`plugins.category.${category}`)}
                        </h3>
                        {plugins.map(plugin => {
                            const key =
                                availabilityKeys[
                                    plugin.availability as keyof typeof availabilityKeys
                                ];
                            const switchId = `plugin-${plugin.id}`;
                            return (
                                <Card key={plugin.id}>
                                    <CardContent className="flex items-start gap-4">
                                        <div className="bg-muted flex size-11 shrink-0 items-center justify-center rounded-2xl">
                                            <EntityIcon
                                                src={plugin.icon}
                                                fallback={PuzzleIcon}
                                                className="size-6"
                                            />
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
                                                {pluginText(
                                                    plugin.locales,
                                                    locale,
                                                    'plugin.description',
                                                    ''
                                                )}
                                            </p>
                                            {plugin.tools.length > 0 && (
                                                <div className="mt-2 flex flex-wrap gap-1.5">
                                                    {plugin.tools.map(tool => (
                                                        <Badge
                                                            key={tool}
                                                            variant="outline"
                                                            className="font-mono"
                                                        >
                                                            {tool}
                                                        </Badge>
                                                    ))}
                                                </div>
                                            )}
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
                                                <Label htmlFor={switchId}>
                                                    {t('plugins.enabled')}
                                                </Label>
                                                <PluginSwitch
                                                    id={switchId}
                                                    pluginId={plugin.id}
                                                    enabled={plugin.enabled}
                                                />
                                            </div>
                                            {((plugin.enabled &&
                                                plugin.availability === 'disabled') ||
                                                (!plugin.enabled &&
                                                    plugin.availability === 'active')) && (
                                                <p className="text-muted-foreground text-xs">
                                                    {t('plugins.restart')}
                                                </p>
                                            )}
                                        </div>
                                    </CardContent>
                                </Card>
                            );
                        })}
                    </section>
                );
            })}
        </div>
    );
}
