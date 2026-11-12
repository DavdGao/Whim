import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { storeMedia, StoreError } from '@whimkit/core';
import { z } from 'zod';

import type { SourceFix, SourceInfo, SourceState } from '../shared/ipc.js';
import type {
    CredentialService,
    McpHost,
    PluginHost,
    RegisteredSourceTemplate,
    SourceRow,
    Store,
} from '@whimkit/core';
import type { MediaBlock } from '@whimkit/core/contracts';
import type {
    SourceContext,
    SourceHealth,
    SourceLogin,
    ToolDefinition,
    ToolOutput,
} from '@whimkit/core/plugin';

// Information sources (design.md §4.2, agent.md §15): each is a long-lived agent session made from
// a plugin's template. The main agent asks them with SendMessage; they answer with Reply.

/** A health check or sign-in step may take this long. */
const checkTimeoutMs = 20_000;
/** A health result is reused this long before a request checks again. */
const healthTtlMs = 60_000;
/** Bounds on what one reply carries into the requester's session. */
const maxReplyFiles = 10;
const maxReplyFileBytes = 20 * 1024 * 1024;
const maxSummaryChars = 2000;
/** The base tools a source agent gets besides its template's; the rest are the main agent's. */
const sourceBaseTools = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch'];

const mediaTypes: Readonly<Record<string, string>> = {
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.html': 'text/html',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
};

/** What Sources needs from Backend. */
export interface SourceHost {
    /** The folder of a session's files. */
    sessionDir(sessionId: string): string;
    /** Start or continue a session's run because a message arrived. */
    wake(sessionId: string): void;
    /** Tell the user, outside the window, that a source needs them. */
    notify(source: SourceRow, health: SourceHealth): void;
    /** What the main agent is called in a session, for the source's view of who asks. */
    requesterName(sessionId: string): Promise<string>;
}

/**
 * Escape a value for an XML attribute.
 * @param value The raw value.
 * @returns The escaped value.
 */
const attribute = (value: string) =>
    value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

/**
 * Wait for a promise, or fail after a timeout.
 * @param work The promise.
 * @param ms The limit.
 * @param what What is waited for, for the error.
 * @returns Its value.
 */
async function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            work,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${what} took too long.`)), ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/** Owns sources: their records, health, and the tools agents use to talk to them. */
export class Sources {
    readonly #health = new Map<string, SourceState & { at: number }>();
    #rows: SourceRow[] = [];

    /**
     * Create the service.
     * @param store Records.
     * @param plugins Source templates.
     * @param mcp MCP servers, for templates that use one.
     * @param credentials Credentials, for templates that need one.
     * @param host Backend services.
     */
    constructor(
        private readonly store: Store,
        private readonly plugins: PluginHost,
        private readonly mcp: McpHost,
        private readonly credentials: CredentialService,
        private readonly host: SourceHost
    ) {}

    /** Read the sources from the store; called at start and after every change. */
    async load(): Promise<void> {
        this.#rows = await this.store.sources();
    }

    /**
     * Every source.
     * @returns Sources, oldest first.
     */
    list(): readonly SourceRow[] {
        return this.#rows;
    }

    /**
     * The source whose session this is.
     * @param sessionId A session.
     * @returns The source, or undefined for a chat.
     */
    bySession(sessionId: string): SourceRow | undefined {
        return this.#rows.find(row => row.sessionId === sessionId);
    }

    /**
     * A source's template.
     * @param source The source.
     * @returns The registration, or undefined when its plugin is not active.
     */
    template(source: SourceRow): RegisteredSourceTemplate | undefined {
        return this.plugins.sources.get(source.template);
    }

    /**
     * The sources for the Feed page.
     * @returns Them with their last known health.
     */
    infos(): SourceInfo[] {
        return this.#rows.map(row => {
            const registered = this.template(row);
            const health = this.#health.get(row.id);
            return {
                id: row.id,
                sessionId: row.sessionId,
                name: row.name,
                template: row.template,
                ...(registered ? { pluginId: registered.pluginId } : {}),
                health: health
                    ? {
                          ...(health.state === 'ready'
                              ? { state: 'ready' as const }
                              : {
                                    state: health.state,
                                    detail: health.detail,
                                    ...(health.fix ? { fix: health.fix } : {}),
                                }),
                          checkedAt: new Date(health.at).toISOString(),
                      }
                    : { state: 'ready' },
            };
        });
    }

    /**
     * A new source id from a name: readable, unique.
     * @param name The name.
     * @returns The id.
     */
    newId(name: string): string {
        const base =
            name
                .toLowerCase()
                .normalize('NFKD')
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '')
                .slice(0, 24)
                .replace(/-+$/, '') || 'source';
        let id = base;
        while (this.#rows.some(row => row.id === id))
            id = `${base}-${randomBytes(2).toString('hex')}`;
        return id;
    }

    /**
     * Record a new source whose session was just created.
     * @param source The source.
     */
    async add(source: SourceRow): Promise<void> {
        await this.store.putSource(source);
        await this.load();
    }

    /**
     * Delete a source with its session; the caller removes its files afterwards.
     * @param sourceId The source.
     * @returns The deleted source.
     */
    async remove(sourceId: string): Promise<SourceRow> {
        const source = this.#rows.find(row => row.id === sourceId);
        if (!source) throw new StoreError('not-found', 'The source no longer exists.');
        await this.store.deleteSource(sourceId);
        this.#health.delete(sourceId);
        await this.load();
        return source;
    }

    /**
     * The services a template's checks receive.
     * @param registered The template.
     * @param signal Aborts the check.
     * @returns The context.
     */
    async #context(
        registered: RegisteredSourceTemplate,
        signal: AbortSignal
    ): Promise<SourceContext> {
        const template = registered.template;
        const type = template.credentialType;
        const credential = type
            ? (await this.credentials.list()).findLast(
                  item => item.typeId === type && item.available
              )
            : undefined;
        return {
            signal,
            callMcp: (tool, input) =>
                template.mcpServer
                    ? this.mcp.call(template.mcpServer, tool, input, signal)
                    : Promise.resolve({ content: 'This source has no MCP server.', isError: true }),
            ...(credential ? { credential: await this.credentials.resolve(credential.id) } : {}),
        };
    }

    /**
     * Check whether a source can run now, reusing a recent result unless asked not to.
     * @param source The source.
     * @param fresh Check again even when a recent result exists.
     * @returns Its health.
     */
    async health(source: SourceRow, fresh = false): Promise<SourceHealth & { fix?: SourceFix }> {
        const cached = this.#health.get(source.id);
        if (!fresh && cached && Date.now() - cached.at < healthTtlMs) return cached;
        const health = await this.#check(source);
        const previous = cached?.state;
        this.#health.set(source.id, { ...health, at: Date.now() });
        if (health.state !== 'ready' && previous !== health.state) this.host.notify(source, health);
        return health;
    }

    /**
     * Run a source's checks: its plugin, its server, its credential, then its own check.
     * @param source The source.
     * @returns Its health.
     */
    async #check(source: SourceRow): Promise<SourceHealth & { fix?: SourceFix }> {
        const registered = this.template(source);
        if (!registered)
            return {
                state: 'needs-setup',
                detail: 'The plugin that provides this source is not active.',
            };
        const template = registered.template;
        if (template.mcpServer) {
            const state = this.mcp.state(template.mcpServer);
            if (state.state !== 'ready')
                return {
                    state: 'needs-setup',
                    fix: { kind: 'mcp', server: template.mcpServer },
                    detail:
                        state.state === 'failed'
                            ? `Its MCP server "${template.mcpServer}" does not connect: ${state.detail}`
                            : `Its MCP server "${template.mcpServer}" is not set up or not running.`,
                };
        }
        if (
            template.credentialType &&
            !(await this.credentials.list()).some(
                item => item.typeId === template.credentialType && item.available
            )
        )
            return {
                state: 'needs-setup',
                fix: { kind: 'credential', typeId: template.credentialType },
                detail: 'It needs an account key in Settings → Models.',
            };
        if (!template.health) return { state: 'ready' };
        const controller = new AbortController();
        try {
            return await within(
                template.health(await this.#context(registered, controller.signal)),
                checkTimeoutMs,
                'The health check'
            );
        } catch (error) {
            controller.abort();
            return {
                state: 'unavailable',
                detail: error instanceof Error ? error.message : String(error),
            };
        }
    }

    /**
     * Start or continue a source's sign-in.
     * @param sourceId The source.
     * @returns What to show the user.
     */
    async login(sourceId: string): Promise<SourceLogin> {
        const source = this.#rows.find(row => row.id === sourceId);
        const registered = source && this.template(source);
        if (!source || !registered?.template.login)
            throw new StoreError('invalid', 'This source has no sign-in.');
        const controller = new AbortController();
        try {
            return await within(
                registered.template.login(await this.#context(registered, controller.signal)),
                checkTimeoutMs,
                'Signing in'
            );
        } finally {
            controller.abort();
        }
    }

    /**
     * Whether a session may use a tool: sources get the base tools, their template's tools, and
     * Reply; chats get everything else.
     * @param sessionId The session.
     * @returns The filter.
     */
    toolFilter(sessionId: string): (name: string) => boolean {
        const source = this.bySession(sessionId);
        if (source) {
            const template = this.template(source)?.template;
            const server = template?.mcpServer;
            return name =>
                name === 'Reply' ||
                sourceBaseTools.includes(name) ||
                (template?.tools.includes(name) ?? false) ||
                (server !== undefined &&
                    (template?.mcpTools
                        ? template.mcpTools.some(tool => name === `mcp__${server}__${tool}`)
                        : name.startsWith(`mcp__${server}__`)));
        }
        const reserved = new Set<string>();
        const servers: string[] = [];
        for (const { template } of this.plugins.sources.values()) {
            for (const tool of template.tools) reserved.add(tool);
            if (template.mcpServer) servers.push(template.mcpServer);
        }
        return name =>
            name !== 'Reply' &&
            !reserved.has(name) &&
            !servers.some(server => name.startsWith(`mcp__${server}__`));
    }

    /**
     * Deliver a request to a source after checking it can run.
     * @param fromSessionId The asking session.
     * @param sourceId The source.
     * @param text The request.
     * @returns The request id, or why it was not delivered.
     */
    async send(
        fromSessionId: string,
        sourceId: string,
        text: string
    ): Promise<{ requestId: string } | { refused: string }> {
        const source = this.#rows.find(row => row.id === sourceId);
        if (!source)
            return {
                refused: `There is no source "${sourceId}"; ListSources shows the sources.`,
            };
        const health = await this.health(source);
        if (health.state !== 'ready')
            return {
                refused: `${source.name} cannot run now (${health.state}): ${health.detail} The user has been told; tell them too if it matters for their request.`,
            };
        const requestId = `r-${randomBytes(4).toString('hex')}`;
        await this.store.execute({
            type: 'send',
            sessionId: source.sessionId,
            operationId: randomUUID(),
            deliveryId: randomUUID(),
            placement: 'next-step',
            item: {
                type: 'notice',
                id: randomUUID(),
                origin: { type: 'core', service: 'sources' },
                observedAt: new Date().toISOString(),
                kind: 'agent-message',
                payload: {
                    requestId,
                    fromSessionId,
                    fromName: await this.host.requesterName(fromSessionId),
                },
                text,
            },
        });
        this.host.wake(source.sessionId);
        return { requestId };
    }

    /**
     * Deliver a source's reply: copy its files into the requester's media, then wake it.
     * @param sessionId The replying source's session.
     * @param requestId The request answered.
     * @param summary A short summary.
     * @param paths The result files, absolute or relative to the source's workspace.
     * @param workspace The source's workspace.
     * @returns What to tell the source.
     */
    async reply(
        sessionId: string,
        requestId: string,
        summary: string,
        paths: readonly string[],
        workspace: string | undefined
    ): Promise<ToolOutput> {
        const source = this.bySession(sessionId);
        if (!source) return { content: 'Only a source can reply.', isError: true };
        const view = await this.store.view(sessionId);
        const request = view.history.find(
            entry =>
                entry.item.type === 'notice' &&
                entry.item.kind === 'agent-message' &&
                entry.item.payload.requestId === requestId
        )?.item;
        if (request?.type !== 'notice' || request.kind !== 'agent-message')
            return {
                content: `There is no request ${requestId}; reply with the id from its <system-notification request="…">.`,
                isError: true,
            };
        if (summary.length > maxSummaryChars)
            return {
                content: `The summary has ${summary.length} characters, more than ${maxSummaryChars}; put the details in a file and keep the summary short.`,
                isError: true,
            };
        if (paths.length > maxReplyFiles)
            return {
                content: `A reply carries at most ${maxReplyFiles} files; combine them.`,
                isError: true,
            };
        const requester = request.payload.fromSessionId;
        const files: MediaBlock[] = [];
        for (const path of paths) {
            const absolute = isAbsolute(path) ? path : resolve(workspace ?? '/', path);
            const info = await stat(absolute).catch(() => null);
            if (!info?.isFile()) return { content: `${absolute} is not a file.`, isError: true };
            if (info.size > maxReplyFileBytes)
                return {
                    content: `${absolute} is larger than ${maxReplyFileBytes / 1024 / 1024} MiB.`,
                    isError: true,
                };
            const data = await readFile(absolute);
            const mediaType =
                mediaTypes[extname(absolute).toLowerCase()] ?? 'application/octet-stream';
            files.push(
                await storeMedia(join(this.host.sessionDir(requester), 'media'), data, mediaType, {
                    name: basename(absolute),
                    ...(mediaType.startsWith('text/') ? { text: data.toString('utf8') } : {}),
                })
            );
        }
        try {
            await this.store.execute({
                type: 'send',
                sessionId: requester,
                operationId: randomUUID(),
                deliveryId: randomUUID(),
                placement: 'next-step',
                item: {
                    type: 'notice',
                    id: randomUUID(),
                    origin: { type: 'core', service: 'sources' },
                    observedAt: new Date().toISOString(),
                    kind: 'agent-reply',
                    payload: { requestId, sourceId: source.id, sourceName: source.name, files },
                    text: summary,
                },
            });
        } catch (error) {
            if (error instanceof StoreError && error.code === 'not-found')
                return {
                    content: 'The conversation that asked was deleted; nobody receives this reply.',
                    isError: true,
                };
            throw error;
        }
        this.host.wake(requester);
        return {
            content: `Delivered your reply to request ${requestId}${files.length ? ` with ${files.length} file${files.length === 1 ? '' : 's'}` : ''}.`,
        };
    }

    /**
     * The tools agents use with sources: SendMessage and ListSources for chats, Reply for
     * sources. Which session gets which is decided by `toolFilter`.
     * @returns The definitions.
     */
    tools(): ToolDefinition<unknown>[] {
        return [
            {
                name: 'ListSources',
                description: listDescription,
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                readOnly: true,
                concurrencySafe: true,
                needsWorkspace: false,
                access: () => [],
                execute: async () => {
                    if (this.#rows.length === 0)
                        return {
                            content: 'There are no sources. The user adds them on the Feed page.',
                        };
                    const lines = await Promise.all(
                        this.#rows.map(async row => {
                            const health = this.#health.get(row.id);
                            const view = await this.store.view(row.sessionId);
                            return `<source id="${attribute(row.id)}" name="${attribute(row.name)}" state="${health?.state ?? 'unchecked'}" busy="${view.run ? 'true' : 'false'}"/>`;
                        })
                    );
                    return { content: lines.join('\n') };
                },
            },
            {
                name: 'SendMessage',
                description: sendDescription,
                inputSchema: {
                    type: 'object',
                    properties: {
                        to: {
                            type: 'string',
                            description: "the source's id, as ListSources shows it, e.g. arxiv",
                        },
                        message: {
                            type: 'string',
                            minLength: 1,
                            maxLength: 8000,
                            description:
                                'the whole request: the question, the time window, and what the report should cover. The source sees only this, not your conversation.',
                        },
                    },
                    required: ['to', 'message'],
                    additionalProperties: false,
                },
                readOnly: false,
                concurrencySafe: true,
                needsWorkspace: false,
                access: () => [],
                execute: async (input, context) => {
                    const { to, message } = z
                        .object({ to: z.string(), message: z.string().min(1) })
                        .parse(input);
                    const result = await this.send(context.sessionId, to, message);
                    if ('refused' in result) return { content: result.refused, isError: true };
                    return {
                        content: `Sent request ${result.requestId} to ${to}. Its reply arrives as a <system-notification kind="reply" request="${result.requestId}"> and wakes you; until then you can go on or end your turn.`,
                    };
                },
            },
            {
                name: 'Reply',
                description: replyDescription,
                inputSchema: {
                    type: 'object',
                    properties: {
                        request: {
                            type: 'string',
                            description:
                                'the request id, from the request\'s <system-notification request="…">',
                        },
                        summary: {
                            type: 'string',
                            minLength: 1,
                            maxLength: maxSummaryChars,
                            description:
                                'a few sentences: what you found, how complete and how verified it is, and where to look in the files',
                        },
                        files: {
                            type: 'array',
                            maxItems: maxReplyFiles,
                            items: { type: 'string' },
                            description:
                                'paths of the report and any data files, absolute or relative to your working folder',
                        },
                    },
                    required: ['request', 'summary'],
                    additionalProperties: false,
                },
                readOnly: false,
                concurrencySafe: false,
                needsWorkspace: false,
                access: () => [],
                execute: async (input, context) => {
                    const {
                        request,
                        summary,
                        files = [],
                    } = z
                        .object({
                            request: z.string(),
                            summary: z.string().min(1),
                            files: z.array(z.string()).optional(),
                        })
                        .parse(input);
                    return this.reply(
                        context.sessionId,
                        request,
                        summary,
                        files,
                        context.workspace
                    );
                },
            },
        ];
    }
}

const listDescription = `List the information sources: each source is an agent of its own that researches one platform, such as arXiv, GitHub or Zhihu, and keeps its earlier reports. Shows each source's id (for SendMessage), name, state (ready, needs-login, needs-setup, unavailable, or unchecked), and whether it is busy with a request.`;

const sendDescription = `Send a request to an information source. The source researches it on its platform, compares with its earlier reports, and replies with a summary and report files.

- The reply arrives later as <system-notification kind="reply" from="<name>" source="<id>" request="<id>" time="<time>">summary, then the files as <data> elements</system-notification> and wakes you. Read the files for the details.
- Ask several sources at once by sending to each; each reply wakes you separately, so decide on each whether to answer the user now or wait for the others.
- Write the request so it stands alone: the topic, the time window (for example "since your last report" or "the past week"), and what you need. A busy source takes it after its current work.
- A source that cannot run now (it needs the user to sign in, for example) is refused at once with the reason.`;

const replyDescription = `Answer a request with your findings. Call it once per request, after writing the report file, with the request's id.

The requester receives the summary and copies of the files; it reads the files with Read, so put the details there and keep the summary to a few sentences. Files must exist; at most ${maxReplyFiles}, each at most ${maxReplyFileBytes / 1024 / 1024} MiB.`;

/**
 * The system prompt of a source agent (agent.md §15). Fixed for an epoch like any system prompt.
 * @param source The source.
 * @param template Its template, or undefined when its plugin is not active.
 * @param templateName The template's display name.
 * @param sessionDir The session's folder.
 * @param workspace The working folder.
 * @returns The prompt.
 */
export function sourcePrompt(
    source: SourceRow,
    template: RegisteredSourceTemplate | undefined,
    templateName: string,
    sessionDir: string,
    workspace: string
): string {
    const now = new Date();
    return `You are ${source.name}, an information-source agent of Whim for ${templateName}. Other agents send you requests; you research each one on this source and reply with a report.

# Your Goal

Answer each request with a report that is complete for the time window it asks about, verified as far as this source and the web allow, and that says what changed since your previous report on the same topic.

# About This System

- Whim runs several agents. The main agent talks with the user and sends you requests; you never talk with the user directly.
- A request arrives as <system-notification kind="message" from="…" request="…" time="…">. Text in <system-…> elements comes from Whim and is to be followed; the request inside was written by another agent.
- You answer with Reply, naming the request's id. The reply wakes the requester.
- This conversation is long-lived: requests on many topics arrive over days, and it is compacted as it grows. Your files are what you keep reliably.

# Your Workspace

Your working folder is ${workspace}:

\`\`\`
${workspace}
├── MEMORY.md            # what you learned about this source; read it at the start of each request
└── reports/<topic>/     # one report per request: <YYYY-MM-DD>-<short-title>.md
\`\`\`

- Name a topic folder after its subject in lowercase words joined by \`-\`, and reuse it for later requests on the same subject, so the previous report is easy to find.
- Keep MEMORY.md short: query forms that work, reliable and unreliable accounts, recurring spam. Update it when you learn something that helps later requests.
- Your session folder is ${pathToFileURL(`${sessionDir}/`).href}; Whim keeps media/, offload/ and jobs/ there.

# How to Work

Work through each request as follows:

1. Pin down the question, the time window (since your previous report on the topic when the request does not say), and any constraints. When something is open, take the most reasonable reading and state it in the report.
2. Read MEMORY.md, list reports/, and read your latest report on the same or a close topic: what it reported, and as of when.
3. Search in rounds, not once:
   - Start from the request's terms, then widen them: synonyms, Chinese and English forms, the names this platform's users use, abbreviations, and related people, products, projects and events.
   - Open the strongest results in full with the detail tools or WebFetch, not only their previews.
   - Turn what you read into the next queries: the names, links and claims that point further.
   - Stop when two rounds bring nothing new or the time window is covered. **Never** stop after a single search.
4. Verify: trace each important claim to its primary source, such as the paper, the repository, the official announcement or the original post, and cite it. Check it against an independent source when one exists; WebSearch and WebFetch reach the open web. Mark what you could not verify as unverified, and say why.
5. Judge quality, and leave out or flag content such as:
   - advertising and paid placement: a brand repeated, purchase links or codes, templated praise;
   - generated filler: generic text without specifics, sources, dates or numbers, or the same template across accounts;
   - reposts and rewrites: prefer the original;
   - engagement that does not fit its account, and accounts acting in concert.
6. Compare with your previous report: what is new, what changed (ranks, numbers, status), what still holds, and what turned out wrong.
7. Write the report file, then Reply.

# The Report

Write the report in Markdown, in the language of the request, with these sections:

- Summary: the answer in a few sentences.
- Changes: New, Changed, Still holds and Corrected, compared with your previous report; "first report on this topic" when there is none.
- Findings: each with its link, when it was posted, and whether it is verified, corroborated or unverified.
- Searches: the queries and tools used, so the next report can build on them.

# Notes

Keep these in mind throughout:

- Give numbers, names and quotes exactly as the source gives them: **never** round or tidy them.
- When the source cannot be reached or a tool fails, say so in the reply rather than guessing; marked partial results are fine.
- Your access is read-only: **never** post, like, follow, message anyone, or change the account. **Never** sign in or enter credentials; when a tool says the account must sign in, reply that the user has to sign in again.

# This Source: ${templateName}

${template?.template.instructions ?? 'The plugin that provides this source is not active, so its tools are missing. Reply to each request that the source is unavailable.'}

<environment observed-at="${now.toISOString()}">
Date: ${now.toISOString().slice(0, 10)}
</environment>`;
}
