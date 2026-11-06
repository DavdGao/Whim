import type { ComponentType } from 'react';

// The client entry API: what a plugin's Renderer code receives (design.md §5.7). A client entry
// is one ES module whose default export is `defineClient({ activate })`. It imports `react`,
// `react/jsx-runtime`, `react-dom`, `sonner`, and `@whimkit/ui/...` as externals, which the host
// provides through its import map, and bundles everything else, including this package.

/** Removes one registration. */
export type Disposer = () => void;

/** Fills `{name}` placeholders from the plugin's own locale catalog in the current locale. */
export type Translate = (key: string, values?: Readonly<Record<string, string | number>>) => string;

/** What a plugin page receives. */
export interface PluginPageProps {
    /** A new object on every navigation to the page. */
    readonly params: Readonly<Record<string, string>>;
    /** Navigate to a page by id, such as `chat` or this plugin's own page ids. */
    navigate(page: string, params?: Readonly<Record<string, string>>): void;
}

/** A page in the navigation rail. Its id is declared in `whim.contributes.pages`. */
export interface PageContribution {
    readonly id: string;
    /** A key in the plugin's locale catalogs. */
    readonly title: string;
    readonly icon: ComponentType<{ className?: string }>;
    readonly component: ComponentType<PluginPageProps>;
}

/** The plugin's section in Settings → Plugins. Its id is declared in `settingsSections`. */
export interface SettingsSectionContribution {
    readonly id: string;
    readonly component: ComponentType;
}

/** One local tool call, as the chat trace shows it. */
export interface ToolCallProps {
    readonly sessionId: string;
    readonly callId: string;
    readonly name: string;
    /** The call's arguments, parsed from JSON; the raw text when it is not valid JSON. */
    readonly input: unknown;
    /** `pending` until it runs, `asking` while waiting for permission, then `running`, then `done`. */
    readonly state: 'pending' | 'asking' | 'running' | 'done';
    /** Present once the call has a result. */
    readonly result?: {
        readonly status: string;
        readonly content: string;
    };
}

/** The renderer of one tool's calls. The tool name is declared in `chatTools`. */
export interface ChatToolContribution {
    readonly tool: string;
    readonly component: ComponentType<ToolCallProps>;
}

/** What a composer action can do to the message being written. */
export interface ComposerHandle {
    insertText(text: string): void;
    attach(files: readonly File[]): void;
}

/** An entry in the composer's Add menu. Its id is declared in `composerActions`. */
export interface ComposerActionContribution {
    readonly id: string;
    /** A key in the plugin's locale catalogs. */
    readonly title: string;
    readonly icon: ComponentType<{ className?: string }>;
    run(composer: ComposerHandle): void | Promise<void>;
}

/** Services a client entry receives. Registrations end when the plugin stops. */
export interface ClientContext {
    readonly pluginId: string;
    /** A hook: the translate function of the current locale, for the plugin's own strings. */
    useT(): Translate;
    readonly rpc: {
        /**
         * Call one of the plugin's host methods. Rejects with the host's error, including
         * invalid input, and when the window reconnects or the plugin stops.
         */
        call<Output = unknown>(method: string, input: unknown): Promise<Output>;
        /** A hook: the latest value of one of the plugin's topics, or undefined before it arrives. */
        useTopic<Value = unknown>(name: string): Value | undefined;
    };
    readonly slots: {
        page(page: PageContribution): Disposer;
        settingsSection(section: SettingsSectionContribution): Disposer;
        chatTool(tool: ChatToolContribution): Disposer;
        composerAction(action: ComposerActionContribution): Disposer;
    };
}

export interface ClientDefinition {
    activate(context: ClientContext): void | Promise<void>;
}

/**
 * Declare a plugin's client entry; the default export of the `client` module.
 * @param definition The client lifecycle.
 * @returns The same definition, typed.
 */
export function defineClient(definition: ClientDefinition): ClientDefinition {
    return definition;
}
