import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { z } from 'zod';

import { CompiledSchema } from './json-schema.js';

import type { Store } from './store.js';
import type {
    ModelAdapter,
    CredentialType,
    Disposer,
    PluginContext,
    PluginDefinition,
    ToolDefinition,
} from '../plugin/index.js';

const manifestSchema = z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    whim: z.strictObject({
        host: z.string().min(1),
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

const toolNamePattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

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
    readonly #statuses = new Map<string, PluginStatus>();
    readonly #scopes = new Map<
        string,
        { disposers: Disposer[]; definition: PluginDefinition; abort: AbortController }
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
                enabled: previous?.enabled ?? true,
            };
            await this.store.putPlugin(row);
            const modified =
                pkg.source === 'local' &&
                previous !== undefined &&
                previous.contentHash !== contentHash;
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
            };
            this.#statuses.set(row.id, status);
            loaded.push({ manifest, dir, status });
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
        } = {
            credentialTypes: [],
            adapters: [],
            tools: [],
        };
        const abort = new AbortController();
        const prefix = `${id}#`;
        const context: PluginContext = {
            pluginId: id,
            version: manifest.version,
            signal: abort.signal,
            credentials: {
                registerType: type => {
                    if (!type.id.startsWith(prefix))
                        throw new Error(`Credential type ids must start with ${prefix}.`);
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
            this.#scopes.set(id, { disposers, definition, abort });
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
