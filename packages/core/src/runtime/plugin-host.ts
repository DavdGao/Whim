import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { z } from 'zod';

import { pluginApiVersion } from '../plugin/index.js';

import { CompiledSchema } from './json-schema.js';

import type { Store } from './store.js';
import type {
    CodingAgentDefinition,
    ModelAdapter,
    CredentialType,
    Disposer,
    MethodDefinition,
    PluginContext,
    PluginDefinition,
    ServiceDefinition,
    ToolDefinition,
} from '../plugin/index.js';

const contributionNames = z.array(z.string().min(1)).default([]);

/** What a plugin declares it registers (design.md §5.1); registering anything else fails. */
const contributesSchema = z
    .strictObject({
        credentialTypes: contributionNames,
        adapters: contributionNames,
        tools: contributionNames,
        services: contributionNames,
        methods: contributionNames,
        topics: contributionNames,
        // Client slots (design.md §5.7); the Renderer enforces them.
        pages: contributionNames,
        settingsSections: contributionNames,
        chatTools: contributionNames,
        composerActions: contributionNames,
        codingAgents: contributionNames,
    })
    .default({
        credentialTypes: [],
        adapters: [],
        tools: [],
        services: [],
        methods: [],
        topics: [],
        pages: [],
        settingsSections: [],
        chatTools: [],
        composerActions: [],
        codingAgents: [],
    });
export type PluginContributions = z.infer<typeof contributesSchema>;

const manifestSchema = z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    whim: z.strictObject({
        api: z.string().regex(/^\d+\.\d+$/, 'Expected MAJOR.MINOR.'),
        host: z.string().min(1),
        /** The Renderer entry: one ES module inside the package. */
        client: z
            .string()
            .regex(/\.m?js$/, 'The client entry must be a .js or .mjs module.')
            .optional(),
        /** Declarative themes: JSON files inside the package (design.md §5.7). */
        themes: z.array(z.string().min(1)).default([]),
        /** Precompiled CSS for the client, in the client entry's directory. */
        clientStyle: z
            .string()
            .regex(/\.css$/, 'The client style must be a .css file.')
            .optional(),
        contributes: contributesSchema,
        cards: z.string().min(1).optional(),
        locales: z.string().min(1).optional(),
        icon: z.string().min(1).optional(),
        category: z.enum(['models', 'tools', 'other']).default('other'),
        icons: z.record(z.string().min(1), z.string().min(1)).default({}),
        requires: z.array(z.string().min(1)).default([]),
    }),
});

const definitionSchema = z.object({
    activate: z.custom<PluginDefinition['activate']>(value => typeof value === 'function'),
    deactivate: z
        .custom<NonNullable<PluginDefinition['deactivate']>>(value => typeof value === 'function')
        .optional(),
});

export type PluginAvailability =
    'active' | 'disabled' | 'failed' | 'modified' | 'missing-dependency';

export interface PluginStatus {
    readonly id: string;
    readonly version: string;
    readonly source: 'bundled' | 'local';
    readonly installedAt: string;
    readonly enabled: boolean;
    readonly availability: PluginAvailability;
    readonly error?: string;
    readonly cardsDir?: string;
    /** Display strings by locale (`en`, `zh-CN`), from the plugin's locale catalogs. */
    readonly locales: Readonly<Record<string, Readonly<Record<string, string>>>>;
    /** The plugin's logo as a `data:` URL. */
    readonly icon?: string;
    /** Named images that cards reference through their `icon` field, as `data:` URLs. */
    readonly icons: Readonly<Record<string, string>>;
    /** Manifest category for grouping in the UI. */
    readonly category: 'models' | 'tools' | 'other';
    /** What the manifest declares the plugin registers. */
    readonly contributes: PluginContributions;
    /** Valid themes from the manifest's `themes` files. */
    readonly themes: readonly PluginTheme[];
    /** The Renderer entry, when the plugin has one: the directory it is served from and its file. */
    readonly client?: { readonly root: string; readonly entry: string; readonly style?: string };
}

/** Design tokens a theme may set (design.md §11.3); values are CSS color or length values. */
export const themeTokens = [
    'background',
    'foreground',
    'card',
    'card-foreground',
    'popover',
    'popover-foreground',
    'primary',
    'primary-foreground',
    'secondary',
    'secondary-foreground',
    'muted',
    'muted-foreground',
    'accent',
    'accent-foreground',
    'destructive',
    'border',
    'input',
    'ring',
    'radius',
    'sidebar',
    'sidebar-foreground',
    'sidebar-primary',
    'sidebar-primary-foreground',
    'sidebar-accent',
    'sidebar-accent-foreground',
    'sidebar-border',
    'sidebar-ring',
] as const;

/** One token value: a plain CSS value, never a declaration break or a resource reference. */
const tokenValueSchema = z
    .string()
    .min(1)
    .max(200)
    .regex(/^[^;{}<>\\]*$/, 'A token value cannot contain ; { } < > or \\.')
    .refine(value => !/url\s*\(|@import|expression\s*\(/i.test(value), {
        message: 'A token value cannot load resources.',
    });

const tokenSetSchema = z.partialRecord(z.enum(themeTokens), tokenValueSchema);

const themeImageTypes: Readonly<Record<string, string>> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
};
const maxThemeImageBytes = 2 * 1024 * 1024;

const themeFileSchema = z.strictObject({
    /** Unique within the plugin: lowercase letters, digits, and `-`. */
    id: z.string().regex(/^[a-z0-9-]{1,64}$/),
    /** A key in the plugin's locale catalogs. */
    name: z.string().min(1).max(200),
    light: tokenSetSchema,
    /** Applied once the application has a dark appearance. */
    dark: tokenSetSchema.optional(),
    /** An image behind the window's chrome, inside the package. */
    backgroundImage: z.string().min(1).optional(),
});

/** A validated theme; `image` is the absolute path of its background image. */
export interface PluginTheme {
    readonly id: string;
    readonly name: string;
    readonly light: Readonly<Partial<Record<(typeof themeTokens)[number], string>>>;
    readonly dark?: Readonly<Partial<Record<(typeof themeTokens)[number], string>>>;
    readonly image?: { readonly path: string; readonly mediaType: string };
}

/**
 * Read a plugin's themes; an invalid theme is reported and skipped.
 * @param dir The package root.
 * @param files The manifest's theme files.
 * @returns Valid themes.
 */
async function readThemes(dir: string, files: readonly string[]): Promise<PluginTheme[]> {
    const themes: PluginTheme[] = [];
    for (const path of files) {
        try {
            const file = resolve(dir, path);
            if (!file.startsWith(dir + sep)) throw new Error('The path leaves the package.');
            const theme = themeFileSchema.parse(JSON.parse(await readFile(file, 'utf8')));
            if (themes.some(other => other.id === theme.id))
                throw new Error(`Theme ${theme.id} exists.`);
            let image: PluginTheme['image'];
            if (theme.backgroundImage) {
                const imagePath = resolve(dirname(file), theme.backgroundImage);
                const mediaType = themeImageTypes[extname(imagePath).toLowerCase()];
                if (!imagePath.startsWith(dir + sep))
                    throw new Error('The image leaves the package.');
                if (!mediaType) throw new Error('Background images are PNG, JPEG, or WebP.');
                if ((await stat(imagePath)).size > maxThemeImageBytes)
                    throw new Error('The background image exceeds 2 MiB.');
                image = { path: imagePath, mediaType };
            }
            themes.push({
                id: theme.id,
                name: theme.name,
                light: theme.light,
                ...(theme.dark ? { dark: theme.dark } : {}),
                ...(image ? { image } : {}),
            });
        } catch (error) {
            console.error(`Invalid theme ${path} in ${dir}:`, describeError(error));
        }
    }
    return themes;
}

/**
 * Locate a client entry: its directory is the only one served to the Renderer (design.md §5.7).
 * @param dir The package root.
 * @param client The manifest's `whim.client`.
 * @param style The manifest's `whim.clientStyle`, which must sit beside the entry.
 * @returns The served root and file names, or nothing when absent or outside the package.
 */
function clientEntry(
    dir: string,
    client: string | undefined,
    style: string | undefined
): Pick<PluginStatus, 'client'> {
    if (!client) return {};
    const file = resolve(dir, client);
    if (!file.startsWith(dir + sep)) {
        console.error(`Client entry ${client} of ${dir} leaves the package; ignored.`);
        return {};
    }
    const root = dirname(file);
    const styleFile = style ? resolve(dir, style) : undefined;
    if (styleFile && dirname(styleFile) !== root)
        console.error(`Client style ${style} of ${dir} is not beside the client entry; ignored.`);
    return {
        client: {
            root,
            entry: basename(file),
            ...(styleFile && dirname(styleFile) === root ? { style: basename(styleFile) } : {}),
        },
    };
}

/**
 * Explain why a plugin built against `required` cannot run on this Core, if it cannot.
 * @param required The manifest's `whim.api`, `MAJOR.MINOR`.
 * @returns The reason, or undefined when compatible.
 */
export function apiIncompatibility(required: string): string | undefined {
    const [major, minor] = required.split('.').map(Number);
    const [ownMajor, ownMinor] = pluginApiVersion.split('.').map(Number);
    return major === ownMajor && minor !== undefined && ownMinor !== undefined && minor <= ownMinor
        ? undefined
        : `Requires plugin API ${required}; this Whim provides ${pluginApiVersion}.`;
}

const iconTypes: Readonly<Record<string, string>> = { svg: 'image/svg+xml', png: 'image/png' };
const maxIconBytes = 64 * 1024;

/**
 * Read one package image into a `data:` URL; an invalid image is reported and skipped.
 * @param dir The package root.
 * @param path The manifest path, relative to the root.
 * @returns The data URL, or undefined.
 */
async function readIcon(dir: string, path: string): Promise<string | undefined> {
    const file = resolve(dir, path);
    const type = iconTypes[file.slice(file.lastIndexOf('.') + 1).toLowerCase()];
    try {
        if (!file.startsWith(dir + sep)) throw new Error('The path leaves the package.');
        if (!type) throw new Error('Only SVG and PNG icons are supported.');
        const bytes = await readFile(file);
        if (bytes.byteLength > maxIconBytes) throw new Error('The icon exceeds 64 KiB.');
        return `data:${type};base64,${bytes.toString('base64')}`;
    } catch (error) {
        console.error(`Invalid plugin icon ${path} in ${dir}:`, describeError(error));
        return undefined;
    }
}

/**
 * Read a plugin's logo and named icons.
 * @param dir The package root.
 * @param manifest The manifest's `whim` field.
 * @param manifest.icon The logo path.
 * @param manifest.icons Named icon paths.
 * @returns The images as data URLs.
 */
async function readIcons(
    dir: string,
    manifest: { icon?: string | undefined; icons: Record<string, string> }
): Promise<Pick<PluginStatus, 'icon' | 'icons'>> {
    const icons: Record<string, string> = {};
    for (const [name, path] of Object.entries(manifest.icons)) {
        const url = await readIcon(dir, path);
        if (url) icons[name] = url;
    }
    const icon = manifest.icon ? await readIcon(dir, manifest.icon) : undefined;
    return { ...(icon ? { icon } : {}), icons };
}

const localeSchema = z.record(z.string(), z.string());

/**
 * Read a plugin's locale catalogs; a missing or invalid catalog is skipped.
 * @param dir The locales directory.
 * @returns Catalogs by locale.
 */
async function readLocales(
    dir: string | undefined
): Promise<Record<string, Record<string, string>>> {
    const result: Record<string, Record<string, string>> = {};
    if (!dir) return result;
    for (const locale of ['en', 'zh-CN']) {
        try {
            result[locale] = localeSchema.parse(
                JSON.parse(await readFile(join(dir, `${locale}.json`), 'utf8'))
            );
        } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
                console.error(`Invalid locale catalog ${locale} in ${dir}:`, describeError(error));
        }
    }
    return result;
}

export interface PluginPackage {
    readonly dir: string;
    readonly source: 'bundled' | 'local';
}

export interface RegisteredCredentialType {
    readonly pluginId: string;
    readonly type: CredentialType;
    readonly schema: CompiledSchema;
}

export interface RegisteredAdapter {
    readonly pluginId: string;
    readonly adapter: ModelAdapter;
    readonly optionsSchema: CompiledSchema;
}

export interface RegisteredTool {
    readonly pluginId: string;
    readonly tool: ToolDefinition<unknown>;
    readonly inputSchema: CompiledSchema;
}

export interface RegisteredCodingAgent {
    readonly pluginId: string;
    readonly agent: CodingAgentDefinition;
}

const toolNamePattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export interface RegisteredMethod {
    readonly pluginId: string;
    readonly method: MethodDefinition;
    readonly inputSchema: CompiledSchema;
    readonly outputSchema: CompiledSchema;
}

/** A topic's latest value; `seq` grows with every publish, starting at 0 for the initial value. */
export interface TopicValue {
    readonly pluginId: string;
    readonly name: string;
    readonly seq: number;
    readonly value: unknown;
}

/** Raised for a plugin call that cannot be made; `code` maps to the IPC error codes. */
export class PluginCallError extends Error {
    /**
     * Describe the refused call.
     * @param code `not-found` for an unknown method, `invalid` for input or output not matching.
     * @param message What went wrong.
     * @param issues Schema issues, when the input was invalid.
     */
    constructor(
        readonly code: 'not-found' | 'invalid',
        message: string,
        readonly issues: readonly { path: string; message: string }[] = []
    ) {
        super(message);
        this.name = 'PluginCallError';
    }
}

/** How long a stopping plugin's services get to settle before deactivation continues. */
const serviceStopMs = 5000;

const activationTimeoutMs = 10_000;

/**
 * Hash a package directory's files (excluding node_modules) in a stable order.
 * @param dir The package root.
 * @returns A SHA-256 hex digest.
 */
async function hashPackage(dir: string): Promise<string> {
    const files: string[] = [];
    const walk = async (current: string) => {
        for (const entry of await readdir(current, { withFileTypes: true })) {
            if (entry.name === 'node_modules') continue;
            const path = join(current, entry.name);
            if (entry.isDirectory()) await walk(path);
            else if (entry.isFile()) files.push(path);
        }
    };
    await walk(dir);
    files.sort();
    const hash = createHash('sha256');
    for (const file of files) {
        hash.update(relative(dir, file).split(sep).join('/'));
        hash.update('\0');
        hash.update(await readFile(file));
        hash.update('\0');
    }
    return hash.digest('hex');
}

/**
 * Describe an error and its causes in one line.
 * @param error Any thrown value.
 * @returns A diagnostic message.
 */
export function describeError(error: unknown): string {
    const parts: string[] = [];
    let current: unknown = error;
    while (current instanceof Error && parts.length < 5) {
        parts.push(current.message);
        current = current.cause;
    }
    return parts.length ? parts.join(' ← ') : String(error);
}

/** Loads plugin packages, tracks installation and availability, and owns their registrations. */
export class PluginHost {
    readonly credentialTypes = new Map<string, RegisteredCredentialType>();
    /** Model adapters of every kind, keyed by id. */
    readonly adapters = new Map<string, RegisteredAdapter>();
    /** Tools in registration order, keyed by model-facing name. */
    readonly tools = new Map<string, RegisteredTool>();
    /** Coding agents by id (design.md §11.4). */
    readonly codingAgents = new Map<string, RegisteredCodingAgent>();
    /** Client-facing methods, keyed `<pluginId>/<name>`. */
    readonly #methods = new Map<string, RegisteredMethod>();
    /** Topic values, keyed `<pluginId>/<name>`. */
    readonly #topics = new Map<string, TopicValue & { schema: CompiledSchema }>();
    readonly #topicListeners = new Set<(topic: TopicValue) => void>();
    readonly #statuses = new Map<string, PluginStatus>();
    readonly #scopes = new Map<
        string,
        {
            disposers: Disposer[];
            definition: PluginDefinition;
            abort: AbortController;
            services: Promise<void>[];
        }
    >();

    /**
     * Create a host over the given packages.
     * @param store Persistence for installation records.
     * @param packages Plugin package directories.
     */
    constructor(
        private readonly store: Store,
        private readonly packages: readonly PluginPackage[]
    ) {}

    /**
     * Current status of every known plugin.
     * @returns Status entries.
     */
    statuses(): PluginStatus[] {
        return [...this.#statuses.values()];
    }

    /**
     * Call one of a plugin's methods for its client entry, validating input and output.
     * @param pluginId The plugin.
     * @param name The method.
     * @param input Untrusted input.
     * @param signal Aborts the call; the plugin stopping aborts it too.
     * @returns The validated output.
     * @throws PluginCallError for an unknown method or invalid input or output.
     */
    async callMethod(
        pluginId: string,
        name: string,
        input: unknown,
        signal: AbortSignal
    ): Promise<unknown> {
        const entry = this.#methods.get(`${pluginId}/${name}`);
        const scope = this.#scopes.get(pluginId);
        if (!entry || !scope)
            throw new PluginCallError('not-found', `Plugin ${pluginId} has no method ${name}.`);
        const issues = entry.inputSchema.issues(input);
        if (issues.length)
            throw new PluginCallError('invalid', `Invalid input for ${name}.`, issues);
        const output = await entry.method.handle(
            input,
            AbortSignal.any([signal, scope.abort.signal])
        );
        const outputIssues = entry.outputSchema.issues(output);
        if (outputIssues.length)
            throw new Error(
                `Plugin ${pluginId} returned invalid output from ${name}: ${outputIssues
                    .map(issue => `${issue.path} ${issue.message}`)
                    .join('; ')}`
            );
        return output;
    }

    /**
     * The latest values of every topic, for a client that connects.
     * @returns Topic values.
     */
    topicValues(): TopicValue[] {
        return [...this.#topics.values()].map(({ pluginId, name, seq, value }) => ({
            pluginId,
            name,
            seq,
            value,
        }));
    }

    /**
     * Follow topic changes.
     * @param listener Receives each published value.
     * @returns The unsubscriber.
     */
    onTopic(listener: (topic: TopicValue) => void): Disposer {
        this.#topicListeners.add(listener);
        return () => this.#topicListeners.delete(listener);
    }

    /** Record installations, verify integrity, and activate enabled plugins in dependency order. */
    async start(): Promise<void> {
        const rows = new Map((await this.store.plugins()).map(row => [row.id, row]));
        const loaded: {
            manifest: z.infer<typeof manifestSchema>;
            dir: string;
            status: PluginStatus;
        }[] = [];
        for (const pkg of this.packages) {
            const dir = resolve(pkg.dir);
            let manifest: z.infer<typeof manifestSchema>;
            try {
                manifest = manifestSchema.parse(
                    JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
                );
            } catch (error) {
                this.#statuses.set(dir, {
                    id: dir,
                    version: '',
                    source: pkg.source,
                    installedAt: '',
                    enabled: false,
                    availability: 'failed',
                    error: `Invalid plugin manifest: ${describeError(error)}`,
                    locales: {},
                    icons: {},
                    category: 'other',
                    contributes: contributesSchema.parse(undefined),
                    themes: [],
                });
                continue;
            }
            const contentHash = await hashPackage(dir);
            const previous = rows.get(manifest.name);
            const row = {
                id: manifest.name,
                version: manifest.version,
                source: pkg.source,
                installedAt: previous?.installedAt ?? new Date().toISOString(),
                // Bundled plugins are covered by the application signature; their hash follows releases.
                contentHash:
                    previous && pkg.source === 'local' ? previous.contentHash : contentHash,
                // A local plugin seen for the first time waits for the user to enable it, after the
                // Plugins page has shown what it declares.
                enabled: previous?.enabled ?? pkg.source === 'bundled',
            };
            await this.store.putPlugin(row);
            const modified =
                pkg.source === 'local' &&
                previous !== undefined &&
                previous.contentHash !== contentHash;
            const incompatible = apiIncompatibility(manifest.whim.api);
            const status: PluginStatus = {
                id: row.id,
                version: row.version,
                source: row.source,
                installedAt: row.installedAt,
                enabled: row.enabled,
                availability: modified ? 'modified' : row.enabled ? 'failed' : 'disabled',
                ...(manifest.whim.cards ? { cardsDir: join(dir, manifest.whim.cards) } : {}),
                locales: await readLocales(
                    manifest.whim.locales ? join(dir, manifest.whim.locales) : undefined
                ),
                ...(await readIcons(dir, manifest.whim)),
                category: manifest.whim.category,
                contributes: manifest.whim.contributes,
                ...clientEntry(dir, manifest.whim.client, manifest.whim.clientStyle),
                themes: await readThemes(dir, manifest.whim.themes),
                ...(incompatible && row.enabled && !modified ? { error: incompatible } : {}),
            };
            this.#statuses.set(row.id, status);
            if (!incompatible) loaded.push({ manifest, dir, status });
        }
        const pending = loaded.filter(
            entry => entry.status.enabled && entry.status.availability !== 'modified'
        );
        // Activate in dependency order; a plugin whose requirement is not active cannot start.
        while (pending.length) {
            const index = pending.findIndex(entry =>
                entry.manifest.whim.requires.every(
                    id => !pending.some(other => other.manifest.name === id)
                )
            );
            if (index < 0) {
                for (const entry of pending.splice(0))
                    this.#setStatus(entry.manifest.name, 'missing-dependency', 'Dependency cycle.');
                break;
            }
            const [entry] = pending.splice(index, 1);
            const missing = entry.manifest.whim.requires.filter(
                id => this.#statuses.get(id)?.availability !== 'active'
            );
            if (missing.length) {
                this.#setStatus(
                    entry.manifest.name,
                    'missing-dependency',
                    `Requires ${missing.join(', ')}.`
                );
                continue;
            }
            await this.#activate(entry.manifest, entry.dir);
        }
    }

    /**
     * Update one plugin's availability.
     * @param id Plugin id.
     * @param availability New availability.
     * @param error Optional error message.
     */
    #setStatus(id: string, availability: PluginAvailability, error?: string): void {
        const current = this.#statuses.get(id);
        if (!current) return;
        const { error: _previous, ...rest } = current;
        this.#statuses.set(id, { ...rest, availability, ...(error ? { error } : {}) });
    }

    /**
     * Import and activate one plugin, rolling back its registrations on failure.
     * @param manifest The validated manifest.
     * @param dir The package root.
     */
    async #activate(manifest: z.infer<typeof manifestSchema>, dir: string): Promise<void> {
        const id = manifest.name;
        const disposers: Disposer[] = [];
        const staged: {
            credentialTypes: RegisteredCredentialType[];
            adapters: RegisteredAdapter[];
            tools: RegisteredTool[];
            codingAgents: RegisteredCodingAgent[];
            services: { service: ServiceDefinition; stop: AbortController }[];
            methods: RegisteredMethod[];
            topics: (TopicValue & { schema: CompiledSchema })[];
        } = {
            credentialTypes: [],
            adapters: [],
            tools: [],
            codingAgents: [],
            services: [],
            methods: [],
            topics: [],
        };
        const abort = new AbortController();
        const prefix = `${id}#`;
        const declared = manifest.whim.contributes;
        const ensureDeclared = (kind: keyof PluginContributions, name: string) => {
            if (!declared[kind].includes(name))
                throw new Error(`${name} is not declared in whim.contributes.${kind}.`);
        };
        const context: PluginContext = {
            pluginId: id,
            version: manifest.version,
            signal: abort.signal,
            credentials: {
                registerType: type => {
                    if (!type.id.startsWith(prefix))
                        throw new Error(`Credential type ids must start with ${prefix}.`);
                    ensureDeclared('credentialTypes', type.id.slice(prefix.length));
                    if (this.credentialTypes.has(type.id))
                        throw new Error(`Credential type ${type.id} exists.`);
                    staged.credentialTypes.push({
                        pluginId: id,
                        type,
                        schema: new CompiledSchema(type.schema),
                    });
                    return () => this.credentialTypes.delete(type.id);
                },
            },
            models: {
                registerAdapter: adapter => {
                    if (!adapter.id.startsWith(prefix))
                        throw new Error(`Adapter ids must start with ${prefix}.`);
                    ensureDeclared('adapters', adapter.id.slice(prefix.length));
                    if (this.adapters.has(adapter.id))
                        throw new Error(`Adapter ${adapter.id} exists.`);
                    staged.adapters.push({
                        pluginId: id,
                        adapter,
                        optionsSchema: new CompiledSchema(adapter.optionsSchema),
                    });
                    return () => this.adapters.delete(adapter.id);
                },
            },
            tools: {
                register: tool => {
                    if (!toolNamePattern.test(tool.name))
                        throw new Error(`Invalid tool name ${tool.name}.`);
                    ensureDeclared('tools', tool.name);
                    if (
                        this.tools.has(tool.name) ||
                        staged.tools.some(entry => entry.tool.name === tool.name)
                    )
                        throw new Error(`Tool ${tool.name} exists.`);
                    staged.tools.push({
                        pluginId: id,
                        tool,
                        inputSchema: new CompiledSchema(tool.inputSchema),
                    });
                    return () => this.tools.delete(tool.name);
                },
            },
            coding: {
                registerAgent: agent => {
                    if (!agent.id.startsWith(prefix))
                        throw new Error(`Coding agent ids must start with ${prefix}.`);
                    ensureDeclared('codingAgents', agent.id.slice(prefix.length));
                    if (
                        !Array.isArray(agent.command) ||
                        agent.command.length === 0 ||
                        !agent.command.every(word => typeof word === 'string' && word.length > 0)
                    )
                        throw new Error(`Coding agent ${agent.id} needs a command.`);
                    if (staged.codingAgents.some(entry => entry.agent.id === agent.id))
                        throw new Error(`Coding agent ${agent.id} exists.`);
                    staged.codingAgents.push({ pluginId: id, agent });
                    return () => this.codingAgents.delete(agent.id);
                },
            },
            services: {
                register: service => {
                    ensureDeclared('services', service.id);
                    if (staged.services.some(entry => entry.service.id === service.id))
                        throw new Error(`Service ${service.id} exists.`);
                    // Stopped by its disposer or when the plugin stops.
                    const stop = new AbortController();
                    abort.signal.addEventListener('abort', () => stop.abort(), { once: true });
                    staged.services.push({ service, stop });
                    return () => stop.abort();
                },
            },
            rpc: {
                method: method => {
                    ensureDeclared('methods', method.name);
                    const key = `${id}/${method.name}`;
                    if (staged.methods.some(entry => entry.method.name === method.name))
                        throw new Error(`Method ${method.name} exists.`);
                    staged.methods.push({
                        pluginId: id,
                        method: method as MethodDefinition,
                        inputSchema: new CompiledSchema(method.inputSchema),
                        outputSchema: new CompiledSchema(method.outputSchema),
                    });
                    return () => this.#methods.delete(key);
                },
                topic: topic => {
                    ensureDeclared('topics', topic.name);
                    if (staged.topics.some(entry => entry.name === topic.name))
                        throw new Error(`Topic ${topic.name} exists.`);
                    const schema = new CompiledSchema(topic.schema);
                    const initialIssues = schema.issues(topic.initial);
                    if (initialIssues.length)
                        throw new Error(`Topic ${topic.name} has an invalid initial value.`);
                    staged.topics.push({
                        pluginId: id,
                        name: topic.name,
                        seq: 0,
                        value: topic.initial,
                        schema,
                    });
                    const key = `${id}/${topic.name}`;
                    return {
                        publish: value => {
                            const current = this.#topics.get(key);
                            // Before activation completes, or after the plugin stopped, nobody follows.
                            if (!current) return;
                            const issues = schema.issues(value);
                            if (issues.length)
                                throw new Error(
                                    `Invalid value for topic ${topic.name}: ${issues
                                        .map(issue => `${issue.path} ${issue.message}`)
                                        .join('; ')}`
                                );
                            const next = { ...current, seq: current.seq + 1, value };
                            this.#topics.set(key, next);
                            const { schema: _schema, ...published } = next;
                            for (const listener of this.#topicListeners) listener(published);
                        },
                    };
                },
            },
        };
        try {
            const module: unknown = await import(pathToFileURL(join(dir, manifest.whim.host)).href);
            const definition = definitionSchema.parse(
                z.object({ default: z.unknown() }).parse(module).default
            );
            let timer: NodeJS.Timeout | undefined;
            await Promise.race([
                definition.activate(context),
                new Promise((_, reject) => {
                    timer = setTimeout(
                        () => reject(new Error('Activation timed out.')),
                        activationTimeoutMs
                    );
                }),
            ]).finally(() => clearTimeout(timer));
            // Registrations become visible only after activation succeeds.
            for (const entry of staged.credentialTypes) {
                this.credentialTypes.set(entry.type.id, entry);
                disposers.push(() => this.credentialTypes.delete(entry.type.id));
            }
            for (const entry of staged.adapters) {
                this.adapters.set(entry.adapter.id, entry);
                disposers.push(() => this.adapters.delete(entry.adapter.id));
            }
            for (const entry of staged.tools) {
                this.tools.set(entry.tool.name, entry);
                disposers.push(() => this.tools.delete(entry.tool.name));
            }
            for (const entry of staged.codingAgents) {
                this.codingAgents.set(entry.agent.id, entry);
                disposers.push(() => this.codingAgents.delete(entry.agent.id));
            }
            for (const entry of staged.methods) {
                const key = `${id}/${entry.method.name}`;
                this.#methods.set(key, entry);
                disposers.push(() => this.#methods.delete(key));
            }
            for (const entry of staged.topics) {
                const key = `${id}/${entry.name}`;
                this.#topics.set(key, entry);
                disposers.push(() => this.#topics.delete(key));
            }
            const services = staged.services.map(({ service, stop }) =>
                Promise.resolve()
                    .then(() => (stop.signal.aborted ? undefined : service.start(stop.signal)))
                    .catch((error: unknown) => {
                        if (stop.signal.aborted) return;
                        console.error(
                            `Service ${service.id} of ${id} failed:`,
                            describeError(error)
                        );
                        this.#setStatus(
                            id,
                            'active',
                            `Service ${service.id} stopped: ${describeError(error)}`
                        );
                    })
            );
            this.#scopes.set(id, { disposers, definition, abort, services });
            this.#setStatus(id, 'active');
        } catch (error) {
            abort.abort();
            this.#setStatus(id, 'failed', describeError(error));
        }
    }

    /** Deactivate all plugins in reverse activation order. */
    async stop(): Promise<void> {
        for (const [id, scope] of [...this.#scopes].reverse()) {
            scope.abort.abort();
            let timer: NodeJS.Timeout | undefined;
            await Promise.race([
                Promise.all(scope.services),
                new Promise(resolve => {
                    timer = setTimeout(resolve, serviceStopMs);
                }),
            ]).finally(() => clearTimeout(timer));
            try {
                await scope.definition.deactivate?.();
            } finally {
                for (const dispose of scope.disposers.reverse()) dispose();
                this.#scopes.delete(id);
            }
        }
    }

    /**
     * Persist whether a plugin should be active; applies after restart.
     * @param id Plugin id.
     * @param enabled Desired activation.
     */
    async setEnabled(id: string, enabled: boolean): Promise<void> {
        const row = (await this.store.plugins()).find(plugin => plugin.id === id);
        if (!row) throw new Error(`Unknown plugin ${id}.`);
        await this.store.putPlugin({ ...row, enabled });
        const status = this.#statuses.get(id);
        if (status) this.#statuses.set(id, { ...status, enabled });
    }
}
