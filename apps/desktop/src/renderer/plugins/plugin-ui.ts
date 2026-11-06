import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';

import { call } from '../lib/client';
import { useT } from '../lib/i18n';
import { pluginText } from '../lib/messages';

import type { ContributionKind, PluginInfo, PluginTopicValue } from '../../shared/ipc';
import type {
    ChatToolContribution,
    ClientContext,
    ComposerActionContribution,
    Disposer,
    PageContribution,
    SettingsSectionContribution,
    Translate,
} from '@whimkit/client';

// Plugin client entries and their slot registrations (design.md §5.7).

type Owned<T> = T & { readonly pluginId: string };

/** Everything plugin client entries registered, as one immutable snapshot. */
export interface PluginRegistrations {
    readonly pages: readonly Owned<PageContribution>[];
    /** By plugin id; one section per plugin. */
    readonly settingsSections: ReadonlyMap<string, Owned<SettingsSectionContribution>>;
    /** By tool name. */
    readonly chatTools: ReadonlyMap<string, Owned<ChatToolContribution>>;
    readonly composerActions: readonly Owned<ComposerActionContribution>[];
    /** Why a plugin's client entry could not load or activate, by plugin id. */
    readonly failures: ReadonlyMap<string, string>;
}

const empty: PluginRegistrations = {
    pages: [],
    settingsSections: new Map(),
    chatTools: new Map(),
    composerActions: [],
    failures: new Map(),
};

/**
 * The page id the shell uses for a plugin's page.
 * @param pluginId The plugin.
 * @param id The page id the plugin registered.
 * @returns The shell page id.
 */
export function pluginPageId(pluginId: string, id: string): string {
    return `plugin:${pluginId}/${id}`;
}

/**
 * Describe a thrown value in one line.
 * @param error Anything thrown.
 * @returns The message.
 */
function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Loads client entries, owns their registrations, and caches plugin topics for the window.
 * Registrations become visible only after `activate` resolves; a failed activation leaves none.
 */
export class PluginUi {
    #snapshot = empty;
    readonly #listeners = new Set<() => void>();
    /** Disposers of each active client entry's registrations. */
    readonly #scopes = new Map<string, Disposer[]>();
    /** Plugin ids whose client module was imported in this window. */
    readonly #imported = new Set<string>();
    #plugins: readonly PluginInfo[] = [];
    readonly #topics = new Map<string, PluginTopicValue>();
    readonly #topicListeners = new Set<() => void>();

    readonly subscribe = (listener: () => void): (() => void) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    };

    readonly snapshot = (): PluginRegistrations => this.#snapshot;

    readonly subscribeTopics = (listener: () => void): (() => void) => {
        this.#topicListeners.add(listener);
        return () => this.#topicListeners.delete(listener);
    };

    /**
     * The latest value of one topic.
     * @param pluginId The plugin.
     * @param name The topic.
     * @returns The value, or undefined before it arrives.
     */
    topic(pluginId: string, name: string): unknown {
        return this.#topics.get(`${pluginId}/${name}`)?.value;
    }

    /**
     * Replace all topic values, after (re)connecting to Backend.
     * @param values Every topic's latest value.
     */
    resetTopics(values: readonly PluginTopicValue[]): void {
        this.#topics.clear();
        for (const value of values) this.#topics.set(`${value.pluginId}/${value.name}`, value);
        for (const listener of this.#topicListeners) listener();
    }

    /**
     * Apply one published topic value, ignoring stale ones.
     * @param value The value.
     */
    receiveTopic(value: PluginTopicValue): void {
        const key = `${value.pluginId}/${value.name}`;
        const current = this.#topics.get(key);
        if (current && current.seq >= value.seq) return;
        this.#topics.set(key, value);
        for (const listener of this.#topicListeners) listener();
    }

    /**
     * Follow the active plugins: load new client entries, drop registrations of stopped ones.
     * @param plugins Plugins from application state.
     */
    sync(plugins: readonly PluginInfo[]): void {
        this.#plugins = plugins;
        const active = new Map(
            plugins.flatMap(plugin =>
                plugin.client && plugin.availability === 'active' ? [[plugin.id, plugin]] : []
            )
        );
        for (const id of [...this.#scopes.keys()]) if (!active.has(id)) this.#dispose(id);
        for (const [id, plugin] of active)
            if (!this.#imported.has(id)) {
                this.#imported.add(id);
                void this.#load(plugin);
            }
    }

    /**
     * Import and activate one client entry.
     * @param plugin The plugin.
     */
    async #load(plugin: PluginInfo): Promise<void> {
        if (!plugin.client) return;
        try {
            if (plugin.client.style) {
                const link = document.createElement('link');
                link.rel = 'stylesheet';
                link.href = plugin.client.style;
                link.dataset.plugin = plugin.id;
                document.head.append(link);
            }
            const module: unknown = await import(/* @vite-ignore */ plugin.client.entry);
            const definition =
                typeof module === 'object' && module !== null && 'default' in module
                    ? module.default
                    : undefined;
            if (
                typeof definition !== 'object' ||
                definition === null ||
                !('activate' in definition) ||
                typeof definition.activate !== 'function'
            )
                throw new Error('The client entry must default-export defineClient({ activate }).');
            const staged: (() => Disposer)[] = [];
            const context = this.#context(plugin, staged);
            await (definition.activate as (context: ClientContext) => unknown)(context);
            // Registrations become visible together, once activation succeeded.
            this.#scopes.set(
                plugin.id,
                staged.map(commit => commit())
            );
        } catch (error) {
            console.error(`Client entry of ${plugin.id} failed:`, error);
            this.#update(snapshot => ({
                ...snapshot,
                failures: new Map(snapshot.failures).set(plugin.id, message(error)),
            }));
        }
    }

    /**
     * Build the context one client entry receives.
     * @param plugin The plugin.
     * @param staged Collects registrations until activation succeeds.
     * @returns The context.
     */
    #context(plugin: PluginInfo, staged: (() => Disposer)[]): ClientContext {
        const pluginId = plugin.id;
        const declared = (kind: ContributionKind, name: string) => {
            if (!plugin.contributes[kind].includes(name))
                throw new Error(`${name} is not declared in whim.contributes.${kind}.`);
        };
        // Before activation a registration is only staged, so its disposer withdraws it.
        const stage = (commit: () => Disposer): Disposer => {
            let dispose: Disposer | undefined;
            const entry = () => {
                dispose = commit();
                return () => dispose?.();
            };
            staged.push(entry);
            return () => {
                const index = staged.indexOf(entry);
                if (index >= 0) staged.splice(index, 1);
                else dispose?.();
            };
        };
        return {
            pluginId,
            useT: () => usePluginT(this, pluginId),
            rpc: {
                call: async <Output>(method: string, input: unknown) =>
                    (await call('plugin.call', { pluginId, method, input })) as Output,
                useTopic: <Value>(name: string) =>
                    usePluginTopic(this, pluginId, name) as Value | undefined,
            },
            slots: {
                page: page => {
                    declared('pages', page.id);
                    return stage(() => {
                        const entry = { ...page, pluginId };
                        this.#update(snapshot => ({
                            ...snapshot,
                            pages: [...snapshot.pages, entry],
                        }));
                        return () =>
                            this.#update(snapshot => ({
                                ...snapshot,
                                pages: snapshot.pages.filter(item => item !== entry),
                            }));
                    });
                },
                settingsSection: section => {
                    declared('settingsSections', section.id);
                    return stage(() => {
                        if (this.#snapshot.settingsSections.has(pluginId))
                            throw new Error(`${pluginId} already has a settings section.`);
                        const entry = { ...section, pluginId };
                        this.#update(snapshot => ({
                            ...snapshot,
                            settingsSections: new Map(snapshot.settingsSections).set(
                                pluginId,
                                entry
                            ),
                        }));
                        return () =>
                            this.#update(snapshot => {
                                const next = new Map(snapshot.settingsSections);
                                if (next.get(pluginId) === entry) next.delete(pluginId);
                                return { ...snapshot, settingsSections: next };
                            });
                    });
                },
                chatTool: tool => {
                    declared('chatTools', tool.tool);
                    if (this.#snapshot.chatTools.has(tool.tool))
                        throw new Error(`Another plugin already renders ${tool.tool}.`);
                    return stage(() => {
                        const entry = { ...tool, pluginId };
                        this.#update(snapshot => ({
                            ...snapshot,
                            chatTools: new Map(snapshot.chatTools).set(tool.tool, entry),
                        }));
                        return () =>
                            this.#update(snapshot => {
                                const next = new Map(snapshot.chatTools);
                                if (next.get(tool.tool) === entry) next.delete(tool.tool);
                                return { ...snapshot, chatTools: next };
                            });
                    });
                },
                composerAction: action => {
                    declared('composerActions', action.id);
                    return stage(() => {
                        const entry = { ...action, pluginId };
                        this.#update(snapshot => ({
                            ...snapshot,
                            composerActions: [...snapshot.composerActions, entry],
                        }));
                        return () =>
                            this.#update(snapshot => ({
                                ...snapshot,
                                composerActions: snapshot.composerActions.filter(
                                    item => item !== entry
                                ),
                            }));
                    });
                },
            },
        };
    }

    /**
     * One plugin's locale catalogs, from the latest application state.
     * @param pluginId The plugin.
     * @returns Its catalogs.
     */
    localesOf(pluginId: string): PluginInfo['locales'] | undefined {
        return this.#plugins.find(plugin => plugin.id === pluginId)?.locales;
    }

    /**
     * Dispose one plugin's registrations, in reverse order.
     * @param pluginId The plugin.
     */
    #dispose(pluginId: string): void {
        for (const dispose of (this.#scopes.get(pluginId) ?? []).reverse()) dispose();
        this.#scopes.delete(pluginId);
    }

    /**
     * Replace the snapshot and notify subscribers.
     * @param change Computes the next snapshot.
     */
    #update(change: (snapshot: PluginRegistrations) => PluginRegistrations): void {
        this.#snapshot = { ...change(this.#snapshot) };
        for (const listener of this.#listeners) listener();
    }
}

/**
 * The `useT` hook a plugin's context provides: its own catalogs in the current locale.
 * @param ui The owner of the plugin's state.
 * @param pluginId The plugin.
 * @returns The translate function.
 */
function usePluginT(ui: PluginUi, pluginId: string): Translate {
    const { locale } = useT();
    const locales = ui.localesOf(pluginId);
    return useCallback(
        (key, values) =>
            pluginText(locales, locale, key, key).replace(/\{(\w+)\}/g, (match, name: string) =>
                String(values?.[name] ?? match)
            ),
        [locales, locale]
    );
}

/**
 * The `useTopic` hook a plugin's context provides.
 * @param ui The owner of the plugin's state.
 * @param pluginId The plugin.
 * @param name The topic.
 * @returns Its latest value.
 */
function usePluginTopic(ui: PluginUi, pluginId: string, name: string): unknown {
    return useSyncExternalStore(ui.subscribeTopics, () => ui.topic(pluginId, name));
}

export const PluginUiContext = createContext<PluginUi | undefined>(undefined);

/**
 * The registrations of plugin client entries.
 * @returns The current snapshot; empty outside the provider.
 */
export function usePluginRegistrations(): PluginRegistrations {
    const ui = useContext(PluginUiContext);
    return useSyncExternalStore(
        ui?.subscribe ?? (() => () => undefined),
        ui?.snapshot ?? (() => empty)
    );
}
