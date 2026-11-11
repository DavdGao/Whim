import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { McpServerConfig, McpServerState, McpServerStatus } from '../contracts/mcp.js';
import type { JsonSchema, ToolDefinition, ToolOutput } from '../plugin/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

// MCP servers (design.md §7.7): Core holds one connection per configured server and shares it
// among every agent, because a server's sign-in state belongs to its account, not to a caller.

export interface McpHostOptions {
    /** Decrypt a secret's ciphertext. */
    readonly decrypt: (ciphertext: Uint8Array) => Promise<string>;
    readonly client: { readonly name: string; readonly version: string };
    /** Called when any server's state or tools change. */
    readonly onChange: () => void;
}

/** Calls one server runs at once; more wait their turn. */
const maxConcurrentCalls = 4;
/** The longest one call may take; progress notifications do not extend it past this. */
const callTimeoutMs = 10 * 60_000;
const firstRetryMs = 1000;
const maxRetryMs = 5 * 60_000;
/** Server-written descriptions are cut here so one server cannot fill the context. */
const maxDescriptionChars = 4000;
/** Model-facing tool names are at most this long (design.md §5.5). */
const maxToolName = 64;

/**
 * The model-facing name of a server's tool.
 * @param serverId The server.
 * @param tool The tool's own name.
 * @returns `mcp__<server>__<tool>`, or undefined when it would not be a valid tool name.
 */
export function mcpToolName(serverId: string, tool: string): string | undefined {
    const name = `mcp__${serverId}__${tool}`;
    return /^[A-Za-z0-9_-]+$/.test(name) && name.length <= maxToolName ? name : undefined;
}

/**
 * Describe a thrown value in one line.
 * @param error The value.
 * @returns Its message.
 */
function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Turn a tool call result into Whim's tool output.
 * @param result The server's result.
 * @returns Text, media, and whether it is an error.
 */
export function toolOutput(result: unknown): ToolOutput {
    const parsed = z
        .object({
            content: z.array(z.record(z.string(), z.unknown())).default([]),
            structuredContent: z.unknown().optional(),
            isError: z.boolean().optional(),
        })
        .safeParse(result);
    if (!parsed.success) return { content: JSON.stringify(result), isError: true };
    const texts: string[] = [];
    const media: { mediaType: string; data: Uint8Array; name?: string }[] = [];
    for (const item of parsed.data.content) {
        const block = z
            .discriminatedUnion('type', [
                z.object({ type: z.literal('text'), text: z.string() }),
                z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string() }),
                z.object({ type: z.literal('audio'), data: z.string(), mimeType: z.string() }),
                z.object({
                    type: z.literal('resource_link'),
                    uri: z.string(),
                    name: z.string().optional(),
                }),
                z.object({
                    type: z.literal('resource'),
                    resource: z.object({
                        uri: z.string(),
                        text: z.string().optional(),
                        blob: z.string().optional(),
                        mimeType: z.string().optional(),
                    }),
                }),
            ])
            .safeParse(item);
        if (!block.success) continue;
        const value = block.data;
        if (value.type === 'text') texts.push(value.text);
        else if (value.type === 'image' || value.type === 'audio')
            media.push({ mediaType: value.mimeType, data: Buffer.from(value.data, 'base64') });
        else if (value.type === 'resource_link')
            texts.push(
                `<resource uri="${value.uri}"${value.name ? ` name="${value.name}"` : ''}/>`
            );
        else if (value.resource.text !== undefined)
            texts.push(
                `<resource uri="${value.resource.uri}">\n${value.resource.text}\n</resource>`
            );
        else if (value.resource.blob !== undefined)
            media.push({
                mediaType: value.resource.mimeType ?? 'application/octet-stream',
                data: Buffer.from(value.resource.blob, 'base64'),
                name: value.resource.uri.split('/').at(-1) ?? 'resource',
            });
    }
    if (texts.length === 0 && parsed.data.structuredContent !== undefined)
        texts.push(JSON.stringify(parsed.data.structuredContent));
    return {
        content: texts.join('\n'),
        ...(media.length ? { media } : {}),
        ...(parsed.data.isError ? { isError: true } : {}),
    };
}

/** One configured server: its connection, its tools, and its reconnection. */
class Connection {
    state: McpServerState = { state: 'connecting' };
    #client: Client | undefined;
    #tools: { name: string; tool: Tool }[] = [];
    #retry: NodeJS.Timeout | undefined;
    #retryMs = firstRetryMs;
    #stopped = false;
    #running = 0;
    readonly #waiting: (() => void)[] = [];

    /**
     * Create the connection; it starts connecting at once.
     * @param config The server's configuration.
     * @param options The host's options.
     */
    constructor(
        readonly config: McpServerConfig,
        private readonly options: McpHostOptions
    ) {
        void this.#connect();
    }

    /**
     * Report a state change.
     * @param state The new state.
     */
    #set(state: McpServerState): void {
        this.state = state;
        this.options.onChange();
    }

    /**
     * The transport of the configuration, with its secrets decrypted.
     * @returns The transport.
     */
    async #transport(): Promise<Transport> {
        const secrets: Record<string, string> = {};
        for (const [key, value] of Object.entries(this.config.secrets))
            secrets[key] = await this.options.decrypt(Buffer.from(value, 'base64'));
        const transport = this.config.transport;
        if (transport.kind === 'stdio')
            return new StdioClientTransport({
                command: transport.command,
                args: transport.args,
                env: { ...transport.env, ...secrets },
                ...(transport.cwd ? { cwd: transport.cwd } : {}),
                stderr: 'ignore',
            });
        return new StreamableHTTPClientTransport(new URL(transport.url), {
            requestInit: { headers: { ...transport.headers, ...secrets } },
        });
    }

    /** Connect, list the tools, and watch for the connection to close. */
    async #connect(): Promise<void> {
        if (this.#stopped) return;
        this.#set({ state: 'connecting' });
        const client = new Client(this.options.client, { capabilities: {} });
        try {
            await client.connect(await this.#transport(), { timeout: 30_000 });
            if (this.#stopped) {
                await client.close();
                return;
            }
            this.#client = client;
            client.onclose = () => {
                if (this.#client !== client) return;
                this.#client = undefined;
                this.#fail('The server closed the connection.');
            };
            client.setNotificationHandler(ToolListChangedNotificationSchema, () =>
                this.#listTools(client).catch(error => this.#fail(messageOf(error)))
            );
            await this.#listTools(client);
            this.#retryMs = firstRetryMs;
        } catch (error) {
            await client.close().catch(() => undefined);
            if (this.#client === client) this.#client = undefined;
            this.#fail(messageOf(error));
        }
    }

    /**
     * Read every page of the server's tools.
     * @param client The connected client.
     */
    async #listTools(client: Client): Promise<void> {
        const tools: Tool[] = [];
        let cursor: string | undefined;
        do {
            const page = await client.listTools(cursor ? { cursor } : {}, { timeout: 30_000 });
            tools.push(...page.tools);
            cursor = page.nextCursor;
        } while (cursor);
        const named = tools.flatMap(tool => {
            const name = mcpToolName(this.config.id, tool.name);
            return name ? [{ name, tool }] : [];
        });
        this.#tools = named;
        this.#set({
            state: 'ready',
            tools: named.map(item => item.name),
            skipped: tools.length - named.length,
        });
    }

    /**
     * Mark the server failed and try again later, waiting longer each time.
     * @param detail Why.
     */
    #fail(detail: string): void {
        if (this.#stopped) return;
        this.#tools = [];
        const retryAt = new Date(Date.now() + this.#retryMs).toISOString();
        this.#set({ state: 'failed', detail, retryAt });
        clearTimeout(this.#retry);
        this.#retry = setTimeout(() => void this.#connect(), this.#retryMs);
        this.#retry.unref();
        this.#retryMs = Math.min(this.#retryMs * 2, maxRetryMs);
    }

    /** Close the connection and stop reconnecting. */
    async stop(): Promise<void> {
        this.#stopped = true;
        clearTimeout(this.#retry);
        const client = this.#client;
        this.#client = undefined;
        await client?.close().catch(() => undefined);
    }

    /**
     * The tool definitions of a ready server.
     * @returns Definitions by model-facing name.
     */
    definitions(): ToolDefinition<unknown>[] {
        return this.#tools.map(({ name, tool }) => this.#definition(name, tool));
    }

    /**
     * The definition of one tool.
     * @param name Its model-facing name.
     * @param tool The server's description of it.
     * @returns The definition.
     */
    #definition(name: string, tool: Tool): ToolDefinition<unknown> {
        const description = (tool.description ?? '').slice(0, maxDescriptionChars);
        const readOnly = tool.annotations?.readOnlyHint === true;
        return {
            name,
            description: `${description}${description ? '\n\n' : ''}(A tool of the MCP server "${this.config.label}".)`,
            inputSchema: tool.inputSchema as JsonSchema,
            readOnly,
            concurrencySafe: readOnly,
            needsWorkspace: false,
            // Untrusted servers ask before every call; the user may allow one tool per chat.
            access: () =>
                this.config.trusted
                    ? []
                    : [{ kind: 'mcp', server: this.config.id, tool: tool.name }],
            execute: async (input, context) => this.call(tool.name, input, context.signal),
        };
    }

    /**
     * Call one of the server's tools, waiting for a free slot first.
     * @param tool The tool's own name.
     * @param input Its arguments.
     * @param signal Aborts the call.
     * @returns The output.
     */
    async call(tool: string, input: unknown, signal: AbortSignal): Promise<ToolOutput> {
        if (this.#running >= maxConcurrentCalls)
            await new Promise<void>(resolve => this.#waiting.push(resolve));
        this.#running++;
        try {
            const client = this.#client;
            if (!client)
                return {
                    content: `The MCP server "${this.config.label}" is not connected right now.`,
                    isError: true,
                };
            const result = await client.callTool(
                { name: tool, arguments: z.record(z.string(), z.unknown()).parse(input) },
                undefined,
                {
                    signal,
                    timeout: callTimeoutMs,
                    resetTimeoutOnProgress: true,
                    maxTotalTimeout: callTimeoutMs,
                }
            );
            return toolOutput(result);
        } finally {
            this.#running--;
            this.#waiting.shift()?.();
        }
    }
}

/** Owns the connections to the configured MCP servers. */
export class McpHost {
    readonly #connections = new Map<string, Connection>();
    #configs: McpServerConfig[] = [];

    /**
     * Create the host; it connects nothing until `configure`.
     * @param options Secrets, client identity, and change notification.
     */
    constructor(private readonly options: McpHostOptions) {}

    /**
     * Apply the configured servers: start new and enabled ones, stop removed, disabled, and
     * changed ones (a changed server reconnects with its new configuration).
     * @param configs The servers.
     */
    async configure(configs: readonly McpServerConfig[]): Promise<void> {
        this.#configs = [...configs];
        for (const [id, connection] of this.#connections) {
            const config = configs.find(item => item.id === id);
            if (!config?.enabled || JSON.stringify(config) !== JSON.stringify(connection.config)) {
                this.#connections.delete(id);
                await connection.stop();
            }
        }
        for (const config of configs)
            if (config.enabled && !this.#connections.has(config.id))
                this.#connections.set(config.id, new Connection(config, this.options));
        this.options.onChange();
    }

    /**
     * Every configured server with its state.
     * @returns Statuses in configuration order.
     */
    statuses(): McpServerStatus[] {
        return this.#configs.map(config => ({
            id: config.id,
            label: config.label,
            ...(this.#connections.get(config.id)?.state ?? { state: 'disabled' as const }),
        }));
    }

    /**
     * One server's state.
     * @param id The server.
     * @returns Its state; `disabled` when it is not connected because it is off or unknown.
     */
    state(id: string): McpServerState {
        return this.#connections.get(id)?.state ?? { state: 'disabled' };
    }

    /**
     * The tools of every ready server, for a new epoch.
     * @returns Definitions.
     */
    tools(): ToolDefinition<unknown>[] {
        return [...this.#connections.values()].flatMap(connection => connection.definitions());
    }

    /**
     * Find a tool by its model-facing name.
     * @param name The name.
     * @returns The definition, or undefined when its server is not ready or has no such tool.
     */
    tool(name: string): ToolDefinition<unknown> | undefined {
        return this.tools().find(tool => tool.name === name);
    }

    /**
     * Call a server's tool directly, for Core services such as a source's health check.
     * @param serverId The server.
     * @param tool The tool's own name.
     * @param input Its arguments.
     * @param signal Aborts the call.
     * @returns The output.
     */
    async call(
        serverId: string,
        tool: string,
        input: Record<string, unknown>,
        signal: AbortSignal
    ): Promise<ToolOutput> {
        const connection = this.#connections.get(serverId);
        if (!connection || connection.state.state !== 'ready')
            return { content: `The MCP server ${serverId} is not connected.`, isError: true };
        return connection.call(tool, input, signal);
    }

    /** Close every connection. */
    async stop(): Promise<void> {
        const connections = [...this.#connections.values()];
        this.#connections.clear();
        await Promise.all(connections.map(connection => connection.stop()));
    }
}
