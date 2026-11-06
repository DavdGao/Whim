import type { MessageKey } from './messages';
import type { AppState } from '../../shared/ipc';
import type { ComponentType } from 'react';

// The navigation contract shared by the host's pages and, later, plugin pages (design.md §5.7).

/** Page parameters, such as the chat to show or the settings section to open. */
export type PageParams = Readonly<Record<string, string>>;

/** Where the shell is: a page and the parameters of the navigation that opened it. */
export interface Location {
    readonly page: string;
    readonly params: PageParams;
}

/** Everything a page receives from the shell. */
export interface PageProps {
    readonly state: AppState;
    /** A new object on every navigation, so a page can react to a repeated request. */
    readonly params: PageParams;
    navigate(page: string, params?: PageParams): void;
}

/** A host message key, or a key in a plugin's own catalogs. */
export type PageTitle = MessageKey | { readonly pluginId: string; readonly key: string };

/** A page in the navigation rail. */
export interface PageEntry {
    readonly id: string;
    readonly title: PageTitle;
    readonly icon: ComponentType<{ className?: string }>;
    /** `main` pages are listed at the top of the rail; `footer` pages at its bottom. */
    readonly placement: 'main' | 'footer';
    readonly component: ComponentType<PageProps>;
}

/** A section of the Settings page. */
export interface SettingsSectionEntry {
    readonly id: string;
    readonly title: MessageKey;
    readonly icon: ComponentType<{ className?: string }>;
    readonly component: ComponentType<{ readonly state: AppState }>;
}
