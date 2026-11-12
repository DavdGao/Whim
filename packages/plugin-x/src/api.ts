import { defineTool } from '@whimkit/core/plugin';
import { z } from 'zod';

import type { ToolDefinition } from '@whimkit/core/plugin';

// X API v2 read endpoints (https://docs.x.com/x-api) with an app-only bearer token.

export const pluginId = '@whimkit/plugin-x';
export const credentialTypeId = `${pluginId}#bearer-token`;
export const apiBase = 'https://api.x.com/2';
const timeoutMs = 30_000;

export const credentialSchema = {
    type: 'object',
    title: 'X API bearer token',
    required: ['bearerToken'],
    additionalProperties: false,
    properties: {
        bearerToken: {
            type: 'string',
            title: 'Bearer token',
            writeOnly: true,
            format: 'password',
            minLength: 1,
        },
    },
} as const;

const credentialValues = z.object({ bearerToken: z.string().min(1) });

export interface SearchInput {
    readonly query: string;
    readonly since?: string;
    readonly until?: string;
    readonly max_results?: number;
    readonly page_token?: string;
}

export interface UserPostsInput {
    readonly username: string;
    readonly include_replies?: boolean;
    readonly include_reposts?: boolean;
    readonly since?: string;
    readonly max_results?: number;
    readonly page_token?: string;
}

const postSchema = z.looseObject({
    id: z.string(),
    text: z.string(),
    author_id: z.string().optional(),
    created_at: z.string().optional(),
    lang: z.string().optional(),
    note_tweet: z.looseObject({ text: z.string() }).optional(),
    public_metrics: z
        .looseObject({
            like_count: z.number().optional(),
            retweet_count: z.number().optional(),
            reply_count: z.number().optional(),
            quote_count: z.number().optional(),
            impression_count: z.number().optional(),
        })
        .optional(),
    referenced_tweets: z.array(z.looseObject({ type: z.string(), id: z.string() })).optional(),
});

const pageSchema = z.looseObject({
    data: z.array(postSchema).optional(),
    includes: z
        .looseObject({
            users: z
                .array(z.looseObject({ id: z.string(), username: z.string(), name: z.string() }))
                .optional(),
        })
        .optional(),
    meta: z.looseObject({
        result_count: z.number().optional(),
        next_token: z.string().optional(),
    }),
});

const userSchema = z.looseObject({
    data: z.looseObject({ id: z.string(), username: z.string(), name: z.string() }).optional(),
});

const errorSchema = z
    .looseObject({
        title: z.string().optional(),
        detail: z.string().optional(),
        errors: z.array(z.looseObject({ message: z.string().optional() })).optional(),
    })
    .partial();

/**
 * The failure text for an HTTP error, following X's documented status codes.
 * @param response The failed response.
 * @param body Its body.
 * @returns A message for the model.
 */
export function failure(response: Response, body: string): string {
    let detail = body.slice(0, 300);
    try {
        const parsed = errorSchema.parse(JSON.parse(body));
        detail = parsed.detail ?? parsed.errors?.[0]?.message ?? parsed.title ?? detail;
    } catch {
        // Keep the raw text.
    }
    const reset = Number(response.headers.get('x-rate-limit-reset'));
    const status = response.status;
    const reason =
        status === 401
            ? 'The X bearer token is missing or invalid; the user can fix it in Settings.'
            : status === 402
              ? 'The X developer account has no credit left for API reads.'
              : status === 403
                ? "The X app's access level does not allow this endpoint."
                : status === 429
                  ? `X is rate limiting this app${reset ? `; the window resets at ${new Date(reset * 1000).toISOString()}` : ''}.`
                  : `X returned HTTP ${status}.`;
    return detail ? `${reason} Detail: ${detail}` : reason;
}

const postFields = 'created_at,author_id,lang,public_metrics,referenced_tweets,note_tweet';

/**
 * Format a page of posts for the model.
 * @param heading The line introducing the result.
 * @param page The parsed page.
 * @returns The text.
 */
export function format(heading: string, page: z.infer<typeof pageSchema>): string {
    const posts = page.data ?? [];
    if (posts.length === 0) return `${heading}\nNo posts.`;
    const names = new Map((page.includes?.users ?? []).map(user => [user.id, user]));
    const lines = [heading];
    posts.forEach((post, index) => {
        const user = post.author_id ? names.get(post.author_id) : undefined;
        const handle = user ? `@${user.username} (${user.name})` : (post.author_id ?? 'unknown');
        const kind = post.referenced_tweets?.map(ref => ref.type).join('+');
        const metrics = post.public_metrics;
        lines.push(
            '',
            `${index + 1}. ${handle} · ${post.created_at ?? 'unknown time'}${kind ? ` · ${kind}` : ''}`,
            `   https://x.com/${user?.username ?? 'i'}/status/${post.id}`,
            `   ${(post.note_tweet?.text ?? post.text).replace(/\s+/g, ' ').trim()}`
        );
        if (metrics)
            lines.push(
                `   likes ${metrics.like_count ?? 0} · reposts ${metrics.retweet_count ?? 0} · replies ${metrics.reply_count ?? 0} · quotes ${metrics.quote_count ?? 0}${metrics.impression_count === undefined ? '' : ` · views ${metrics.impression_count}`}`
            );
    });
    if (page.meta.next_token)
        lines.push('', `More posts are available: page_token "${page.meta.next_token}".`);
    return lines.join('\n');
}

/**
 * Call the API and parse the answer.
 * @param transport The fetch implementation.
 * @param url The request URL.
 * @param token The bearer token.
 * @param outer The tool call's abort signal.
 * @param schema The response schema.
 * @returns The parsed body, or an error result.
 */
async function get<T extends z.ZodType>(
    transport: typeof fetch,
    url: URL,
    token: string,
    outer: AbortSignal,
    schema: T
): Promise<{ value: z.infer<T> } | { error: string }> {
    let response: Response;
    try {
        response = await transport(url, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.any([outer, AbortSignal.timeout(timeoutMs)]),
        });
    } catch (error) {
        if (outer.aborted) throw error;
        return {
            error: `Could not reach X: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
    const body = await response.text();
    if (!response.ok) return { error: failure(response, body) };
    try {
        return { value: schema.parse(JSON.parse(body)) };
    } catch {
        return { error: 'X returned a response Whim could not read.' };
    }
}

const limitSchema = (max: number, min: number) =>
    ({
        type: 'integer',
        minimum: min,
        maximum: max,
        description: `How many posts to return (${min}–${max}, default 20).`,
    }) as const;

const tokenSchema = {
    type: 'string',
    description: 'The page_token from the previous result, to continue to older posts.',
} as const;

/**
 * Midnight UTC of a date, as X wants times.
 * @param date `YYYY-MM-DD`.
 * @returns An ISO timestamp.
 */
const startOf = (date: string) => `${date}T00:00:00Z`;

/**
 * The XSearch tool: recent search over the last seven days.
 * @param transport The fetch implementation; injectable for tests.
 * @returns The tool.
 */
export function createSearchTool(transport: typeof fetch = fetch): ToolDefinition<SearchInput> {
    return defineTool<SearchInput>({
        name: 'XSearch',
        description:
            'Search posts on X from the last 7 days, newest first. Returns each post with author, time, text, link and counts.\n\n' +
            'The query uses X operators: words and "phrases", OR, - to exclude, from:user, to:user, #tag, @mention, lang:en, has:links, has:media, is:reply, -is:retweet, -is:reply. Combine with spaces (AND) and parentheses. ' +
            'Older than 7 days is not searchable. Counts are a snapshot at the time of the call.',
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 512,
                    description:
                        'The X search query, e.g. `("agent memory" OR #LLM) lang:en -is:retweet`.',
                },
                since: {
                    type: 'string',
                    pattern: '^\\d{4}-\\d{2}-\\d{2}$',
                    description:
                        'Only posts on or after this UTC date, YYYY-MM-DD (within the last 7 days).',
                },
                until: {
                    type: 'string',
                    pattern: '^\\d{4}-\\d{2}-\\d{2}$',
                    description: 'Only posts before this UTC date, YYYY-MM-DD.',
                },
                max_results: limitSchema(100, 10),
                page_token: tokenSchema,
            },
            required: ['query'],
            additionalProperties: false,
        },
        readOnly: true,
        concurrencySafe: true,
        needsWorkspace: false,
        credentialType: credentialTypeId,
        access: () => [{ kind: 'network', url: apiBase }],
        async execute(input, context) {
            if (!context.credential)
                return { content: 'No X bearer token is configured.', isError: true };
            const { bearerToken } = credentialValues.parse(context.credential.values);
            const url = new URL(`${apiBase}/tweets/search/recent`);
            url.searchParams.set('query', input.query);
            url.searchParams.set('max_results', String(input.max_results ?? 20));
            url.searchParams.set('tweet.fields', postFields);
            url.searchParams.set('expansions', 'author_id');
            url.searchParams.set('user.fields', 'username,name');
            if (input.since) url.searchParams.set('start_time', startOf(input.since));
            if (input.until) url.searchParams.set('end_time', startOf(input.until));
            if (input.page_token) url.searchParams.set('next_token', input.page_token);
            const result = await get(transport, url, bearerToken, context.signal, pageSchema);
            if ('error' in result) return { content: result.error, isError: true };
            return {
                content: format(
                    `Recent posts matching "${input.query}", newest first:`,
                    result.value
                ),
            };
        },
    });
}

/**
 * The XUserPosts tool: an account's latest posts.
 * @param transport The fetch implementation; injectable for tests.
 * @returns The tool.
 */
export function createUserPostsTool(
    transport: typeof fetch = fetch
): ToolDefinition<UserPostsInput> {
    return defineTool<UserPostsInput>({
        name: 'XUserPosts',
        description:
            "List an X account's latest posts, newest first (up to its most recent 3200). " +
            'Replies and reposts are left out unless asked for. Use it to follow chosen accounts; use XSearch for topics.',
        inputSchema: {
            type: 'object',
            properties: {
                username: {
                    type: 'string',
                    pattern: '^@?[A-Za-z0-9_]{1,15}$',
                    description: 'The account handle, with or without @.',
                },
                include_replies: {
                    type: 'boolean',
                    description: 'Include the account’s replies (default false).',
                },
                include_reposts: {
                    type: 'boolean',
                    description: 'Include the account’s reposts of others (default false).',
                },
                since: {
                    type: 'string',
                    pattern: '^\\d{4}-\\d{2}-\\d{2}$',
                    description: 'Only posts on or after this UTC date, YYYY-MM-DD.',
                },
                max_results: limitSchema(100, 5),
                page_token: tokenSchema,
            },
            required: ['username'],
            additionalProperties: false,
        },
        readOnly: true,
        concurrencySafe: true,
        needsWorkspace: false,
        credentialType: credentialTypeId,
        access: () => [{ kind: 'network', url: apiBase }],
        async execute(input, context) {
            if (!context.credential)
                return { content: 'No X bearer token is configured.', isError: true };
            const { bearerToken } = credentialValues.parse(context.credential.values);
            const handle = input.username.replace(/^@/, '');
            const user = await get(
                transport,
                new URL(`${apiBase}/users/by/username/${encodeURIComponent(handle)}`),
                bearerToken,
                context.signal,
                userSchema
            );
            if ('error' in user) return { content: user.error, isError: true };
            if (!user.value.data)
                return { content: `No X account @${handle} exists.`, isError: true };
            const url = new URL(`${apiBase}/users/${user.value.data.id}/tweets`);
            url.searchParams.set('max_results', String(input.max_results ?? 20));
            url.searchParams.set('tweet.fields', postFields);
            const exclude = [
                ...(input.include_replies ? [] : ['replies']),
                ...(input.include_reposts ? [] : ['retweets']),
            ];
            if (exclude.length > 0) url.searchParams.set('exclude', exclude.join(','));
            if (input.since) url.searchParams.set('start_time', startOf(input.since));
            if (input.page_token) url.searchParams.set('pagination_token', input.page_token);
            const result = await get(transport, url, bearerToken, context.signal, pageSchema);
            if ('error' in result) return { content: result.error, isError: true };
            // The timeline answers without author expansions; the account is known.
            const page = {
                ...result.value,
                includes: { users: [user.value.data] },
                data: (result.value.data ?? []).map(post => ({
                    ...post,
                    author_id: post.author_id ?? user.value.data?.id,
                })),
            };
            return {
                content: format(
                    `Latest posts by @${user.value.data.username}, newest first:`,
                    page
                ),
            };
        },
    });
}
