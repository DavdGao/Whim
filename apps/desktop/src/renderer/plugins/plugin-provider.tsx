import { Component, useEffect, useState } from 'react';

import { StatusAlert } from '../components/status-alert';
import { useAppState } from '../lib/app-state-context';
import { call, onStatus, subscribe } from '../lib/client';
import { useT } from '../lib/i18n';
import { pluginText } from '../lib/messages';

import { PluginUi, PluginUiContext } from './plugin-ui';

import type { ReactNode } from 'react';

/**
 * Own the window's plugin client entries: load them as plugins become active, and keep their
 * topics current.
 * @param props Children.
 * @param props.children Descendants.
 * @returns The provider.
 */
export function PluginUiProvider({ children }: { children: ReactNode }) {
    const { state } = useAppState();
    const [ui] = useState(() => new PluginUi());
    useEffect(() => {
        if (state) ui.sync(state.plugins);
    }, [ui, state]);
    useEffect(() => {
        const refresh = () =>
            void call('plugin.topics', {}).then(
                values => ui.resetTopics(values),
                (error: unknown) => console.error('Cannot read plugin topics:', error)
            );
        refresh();
        const unsubscribe = subscribe(event => {
            if (event.type === 'plugin.topic') ui.receiveTopic(event);
        });
        // A restarted Backend starts its topics over.
        const unwatch = onStatus(status => {
            if (status === 'connected') refresh();
        });
        return () => {
            unsubscribe();
            unwatch();
        };
    }, [ui]);
    return <PluginUiContext.Provider value={ui}>{children}</PluginUiContext.Provider>;
}

/**
 * The failure shown in place of a plugin's content.
 * @param props The failure.
 * @param props.pluginId The plugin.
 * @param props.error What it threw.
 * @returns The alert.
 */
function PluginFailure({ pluginId, error }: { pluginId: string; error: string }) {
    const { t, locale } = useT();
    const { state } = useAppState();
    const plugin = state?.plugins.find(item => item.id === pluginId);
    const name = pluginText(plugin?.locales, locale, 'plugin.name', pluginId);
    return (
        <StatusAlert tone="error" title={t('plugins.renderFailed', { name })}>
            {error}
        </StatusAlert>
    );
}

/**
 * Contains a plugin component's render errors, so a broken plugin never blanks the page.
 */
export class PluginBoundary extends Component<
    { pluginId: string; children: ReactNode },
    { error?: string }
> {
    state: { error?: string } = {};

    /**
     * Keep the error for display.
     * @param error What the component threw.
     * @returns The next state.
     */
    static getDerivedStateFromError(error: unknown): { error: string } {
        return { error: error instanceof Error ? error.message : String(error) };
    }

    /**
     * Report the error with the plugin's id.
     * @param error What the component threw.
     */
    componentDidCatch(error: unknown): void {
        console.error(`Plugin ${this.props.pluginId} failed to render:`, error);
    }

    /**
     * Render the plugin's content, or its failure.
     * @returns The content.
     */
    render(): ReactNode {
        return this.state.error === undefined ? (
            this.props.children
        ) : (
            <PluginFailure pluginId={this.props.pluginId} error={this.state.error} />
        );
    }
}
