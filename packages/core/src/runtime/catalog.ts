import { watch } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { cardSchema } from '../contracts/card.js';

import { describeError } from './plugin-host.js';

import type { PluginHost } from './plugin-host.js';
import type { Card, ChatCard, DecisionCard } from '../contracts/card.js';

export interface CatalogEntry {
    readonly id: string;
    /** `upstream`: plugin seed; `patched`: seed with a user patch; `user`: user-created. */
    readonly layer: 'upstream' | 'patched' | 'user';
    readonly pluginId?: string;
    readonly files: readonly string[];
    readonly hidden: boolean;
    /** Present when the card is valid and an adapter of its kind is available. */
    readonly card?: Card;
    readonly issues: readonly string[];
}

/**
 * Apply an RFC 7386 JSON Merge Patch.
 * @param target The original document.
 * @param patch The patch.
 * @returns The patched document.
 */
export function mergePatch(target: unknown, patch: unknown): unknown {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
    const result: Record<string, unknown> =
        target !== null && typeof target === 'object' && !Array.isArray(target)
            ? { ...target }
            : {};
    for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete result[key];
        else result[key] = mergePatch(result[key], value);
    }
    return result;
}

/**
 * Read every JSON file in a directory.
 * @param dir The directory.
 * @returns Parsed documents or per-file errors.
 */
async function readJsonFiles(
    dir: string
): Promise<{ file: string; value?: unknown; error?: string }[]> {
    let names: string[];
    try {
        names = (await readdir(dir)).filter(name => name.endsWith('.json')).sort();
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
        throw error;
    }
    return Promise.all(
        names.map(async name => {
            const file = join(dir, name);
            try {
                return { file, value: JSON.parse(await readFile(file, 'utf8')) as unknown };
            } catch (error) {
                return { file, error: `Cannot read ${name}: ${describeError(error)}` };
            }
        })
    );
}

/**
 * Read the `id` field of an untrusted document.
 * @param value The document.
 * @returns The id, or undefined.
 */
function idOf(value: unknown): string | undefined {
    if (value === null || typeof value !== 'object' || !('id' in value)) return undefined;
    return typeof value.id === 'string' && value.id.length > 0 ? value.id : undefined;
}

/** The effective model catalog: plugin seeds merged with the user layer. */
export class Catalog {
    #entries = new Map<string, CatalogEntry>();
    readonly #listeners = new Set<() => void>();
    #watcher: ReturnType<typeof watch> | undefined;
    #timer: NodeJS.Timeout | undefined;

    /**
     * Create a catalog.
     * @param host Active plugins provide seed directories and adapters.
     * @param userDir Directory of user cards and patches.
     */
    constructor(
        private readonly host: PluginHost,
        readonly userDir: string
    ) {}

    /**
     * All entries, including invalid ones.
     * @returns Catalog entries sorted by name.
     */
    entries(): CatalogEntry[] {
        return [...this.#entries.values()].sort((left, right) =>
            (left.card?.name ?? left.id).localeCompare(right.card?.name ?? right.id)
        );
    }

    /**
     * A selectable card by id.
     * @param id Card id.
     * @returns The valid card, or undefined.
     */
    card(id: string): Card | undefined {
        const entry = this.#entries.get(id);
        return entry && !entry.hidden ? entry.card : undefined;
    }

    /**
     * A selectable Chat card by id.
     * @param id Card id.
     * @returns The valid Chat card, or undefined.
     */
    chatCard(id: string): ChatCard | undefined {
        const card = this.card(id);
        return card?.kind === 'chat' ? card : undefined;
    }

    /**
     * A selectable Decision card by id.
     * @param id Card id.
     * @returns The valid Decision card, or undefined.
     */
    decisionCard(id: string): DecisionCard | undefined {
        const card = this.card(id);
        return card?.kind === 'decision' ? card : undefined;
    }

    /**
     * Observe catalog reloads.
     * @param listener Called after each reload.
     * @returns A disposer.
     */
    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    /** Load all layers and start watching the user directory. */
    async start(): Promise<void> {
        await mkdir(this.userDir, { recursive: true });
        await this.reload();
        this.#watcher = watch(this.userDir, () => {
            clearTimeout(this.#timer);
            this.#timer = setTimeout(() => {
                this.reload().catch(error =>
                    console.error('Catalog reload failed:', describeError(error))
                );
            }, 200);
        });
    }

    /** Stop watching. */
    stop(): void {
        clearTimeout(this.#timer);
        this.#watcher?.close();
    }

    /** Re-read every layer and re-validate all cards. */
    async reload(): Promise<void> {
        const raw = new Map<
            string,
            {
                value: unknown;
                layer: CatalogEntry['layer'];
                pluginId?: string;
                files: string[];
                issues: string[];
                hidden: boolean;
            }
        >();
        const orphanIssues: CatalogEntry[] = [];
        for (const status of this.host.statuses()) {
            if (status.availability !== 'active' || !status.cardsDir) continue;
            for (const file of await readJsonFiles(status.cardsDir)) {
                const id = idOf(file.value);
                if (file.error || !id) {
                    orphanIssues.push(
                        invalidFile(
                            file.file,
                            file.error ?? 'Card has no id.',
                            'upstream',
                            status.id
                        )
                    );
                    continue;
                }
                if (raw.has(id)) {
                    raw.get(id)?.issues.push(`Duplicate card id in ${file.file}.`);
                    continue;
                }
                raw.set(id, {
                    value: file.value,
                    layer: 'upstream',
                    pluginId: status.id,
                    files: [file.file],
                    issues: [],
                    hidden: false,
                });
            }
        }
        for (const file of await readJsonFiles(this.userDir)) {
            const id = idOf(file.value);
            if (file.error || !id) {
                orphanIssues.push(invalidFile(file.file, file.error ?? 'Card has no id.', 'user'));
                continue;
            }
            const upstream = raw.get(id);
            const patch = file.value as Record<string, unknown>;
            const hidden = patch.hidden === true;
            const { hidden: _hidden, ...rest } = patch;
            if (upstream && upstream.layer === 'upstream') {
                raw.set(id, {
                    ...upstream,
                    value: mergePatch(upstream.value, rest),
                    layer: 'patched',
                    files: [...upstream.files, file.file],
                    hidden,
                });
            } else if (upstream) {
                upstream.issues.push(`Duplicate user card id in ${file.file}.`);
            } else {
                raw.set(id, { value: rest, layer: 'user', files: [file.file], issues: [], hidden });
            }
        }
        const entries = new Map<string, CatalogEntry>();
        for (const [id, item] of raw) {
            const issues = [...item.issues];
            const parsed = cardSchema.safeParse(item.value);
            let card: Card | undefined;
            if (!parsed.success) {
                issues.push(
                    ...parsed.error.issues.map(
                        issue => `${issue.path.join('.') || 'card'}: ${issue.message}`
                    )
                );
            } else {
                const data = parsed.data;
                const adapter = this.host.adapters.get(data.adapter);
                if (!adapter) issues.push(`Adapter ${data.adapter} is not available.`);
                else if (adapter.adapter.kind !== data.kind)
                    issues.push(`Adapter ${data.adapter} serves ${adapter.adapter.kind} models.`);
                else {
                    issues.push(
                        ...adapter.optionsSchema
                            .issues(data.options)
                            .map(issue => `options${issue.path}: ${issue.message}`)
                    );
                    if (adapter.adapter.kind === 'chat' && data.kind === 'chat')
                        issues.push(
                            ...(adapter.adapter.validateCard?.(data) ?? []).map(
                                issue => `${issue.path}: ${issue.message}`
                            )
                        );
                }
                if (issues.length === 0) card = data;
            }
            entries.set(id, {
                id,
                layer: item.layer,
                ...(item.pluginId ? { pluginId: item.pluginId } : {}),
                files: item.files,
                hidden: item.hidden,
                ...(card ? { card } : {}),
                issues,
            });
        }
        for (const entry of orphanIssues) entries.set(`invalid:${entry.files[0]}`, entry);
        this.#entries = entries;
        for (const listener of this.#listeners) listener();
    }
}

/**
 * Build an entry for a file that could not be read as a card.
 * @param file The file path.
 * @param issue The problem.
 * @param layer The layer it came from.
 * @param pluginId The plugin, for seeds.
 * @returns An invalid entry.
 */
function invalidFile(
    file: string,
    issue: string,
    layer: CatalogEntry['layer'],
    pluginId?: string
): CatalogEntry {
    return {
        id: file,
        layer,
        ...(pluginId ? { pluginId } : {}),
        files: [file],
        hidden: false,
        issues: [issue],
    };
}
