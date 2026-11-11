import { z } from 'zod';

// MCP server configuration and state (design.md §7.7), shared by Backend and Renderer.

/** A server's id appears in its tools' names, so it is short and safe in a tool name. */
export const mcpServerIdPattern = /^[a-z0-9][a-z0-9-]{0,19}$/;

export const mcpServerSchema = z.strictObject({
    id: z.string().regex(mcpServerIdPattern),
    label: z.string().trim().min(1).max(60),
    enabled: z.boolean(),
    /** The user lets its calls run without asking. */
    trusted: z.boolean(),
    transport: z.discriminatedUnion('kind', [
        z.strictObject({
            kind: z.literal('stdio'),
            command: z.string().min(1),
            args: z.array(z.string()),
            cwd: z.string().min(1).optional(),
            env: z.record(z.string(), z.string()),
        }),
        z.strictObject({
            kind: z.literal('http'),
            url: z.url({ protocol: /^https?$/ }),
            headers: z.record(z.string(), z.string()),
        }),
    ]),
    /**
     * Environment variables (stdio) or headers (http) whose values are secret, as base64
     * `safeStorage` ciphertext; never returned to Renderer.
     */
    secrets: z.record(z.string(), z.string()),
});
export type McpServerConfig = z.infer<typeof mcpServerSchema>;

export type McpServerState =
    | { readonly state: 'disabled' }
    | { readonly state: 'connecting' }
    | { readonly state: 'ready'; readonly tools: readonly string[]; readonly skipped: number }
    | { readonly state: 'failed'; readonly detail: string; readonly retryAt?: string };

export type McpServerStatus = McpServerState & { readonly id: string; readonly label: string };
