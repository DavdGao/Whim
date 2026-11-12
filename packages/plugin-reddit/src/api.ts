import { defineTool } from '@whimkit/core/plugin';
import { z } from 'zod';

import type { ToolDefinition } from '@whimkit/core/plugin';

// Reddit Data API (https://www.reddit.com/dev/api/) with app-only OAuth: no user is signed in,
// so the tools read public subreddits only.

export const pluginId = '@whimkit/plugin-reddit';
export const credentialTypeId = `${pluginId}#oauth-app`;
export const tokenUrl = 'https://www.reddit.com/api/v1/access_token';
export const apiBase = 'https://oauth.reddit.com';
const userAgent = 'macos:whim:0.1.0 (read-only source agent)';
const timeoutMs = 30_000;
const maxBodyChars = 1200;

export const credentialSchema = {
    type: 'object',
    title: 'Reddit API app',
    required: ['clientId'],
    additionalProperties: false,
    properties: {
        clientId: { type: 'string', title: 'Client ID', minLength: 1 },
        clientSecret: {
            type: 'string',
            title: 'Client secret (leave empty for an installed app)',
            writeOnly: true,
            format: 'password',
        },
    },
} as const;

const credentialValues = z.object({
    clientId: z.string().min(1),
    clientSecret: z.string().optional(),
});

export interface ListingInput {
    readonly subreddit: string;
    readonly sort?: 'hot' | 'new' | 'top' | 'rising';
    readonly time?: 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';
    readonly limit?: number;
    readonly after?: string;
}

export interface SearchInput {
    readonly query: string;
    readonly subreddit?: string;
    readonly sort?: 'relevance' | 'new' | 'top' | 'comments';
    readonly time?: 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';
    readonly limit?: number;
    readonly after?: string;
}

export interface CommentsInput {
    readonly post: string;
    readonly sort?: 'confidence' | 'top' | 'new' | 'controversial';
    readonly limit?: number;
}

const tokenSchema = z.looseObject({ access_token: z.string(), expires_in: z.number() });

const postSchema = z.looseObject({
    id: z.string(),
    name: z.string(),
    title: z.string(),
    author: z.string().optional(),
    subreddit: z.string(),
    score: z.number().optional(),
    upvote_ratio: z.number().optional(),
    num_comments: z.number().optional(),
    created_utc: z.number(),
    permalink: z.string(),
    url: z.string().optional(),
    is_self: z.boolean().optional(),
    selftext: z.string().optional(),
    over_18: z.boolean().optional(),
    stickied: z.boolean().optional(),
    link_flair_text: z.string().nullish(),
});

const listingSchema = z.looseObject({
    data: z.looseObject({
        after: z.string().nullish(),
        children: z.array(z.looseObject({ kind: z.string(), data: z.looseObject({}) })),
    }),
});

interface CommentNode {
    readonly author: string;
    readonly body: string;
    readonly score: number;
    readonly depth: number;
    readonly created: number;
}

const commentSchema = z.looseObject({
    author: z.string().optional(),
    body: z.string().optional(),
    score: z.number().optional(),
    depth: z.number().optional(),
    created_utc: z.number().optional(),
    replies: z.unknown().optional(),
});

/**
 * Cut long text for the model.
 * @param value Raw text.
 * @returns One line, bounded.
 */
const brief = (value: string) => {
    const text = value.replace(/\s+/g, ' ').trim();
    return text.length > maxBodyChars ? `${text.slice(0, maxBodyChars)}…` : text;
};

const when = (utc: number) => new Date(utc * 1000).toISOString().slice(0, 16) + 'Z';

/**
 * The failure text for an HTTP error from Reddit.
 * @param response The failed response.
 * @param context What was being done.
 * @returns A message for the model.
 */
export function failure(response: Response, context: string): string {
    const status = response.status;
    const reset = response.headers.get('x-ratelimit-reset');
    const reason =
        status === 401
            ? 'The Reddit credentials are missing or invalid; the user can fix them in Settings.'
            : status === 403
              ? `Reddit refused ${context}: the subreddit is private, quarantined, banned, or the app lacks access.`
              : status === 404
                ? `Reddit has no such ${context}.`
                : status === 429
                  ? `Reddit is rate limiting this app${reset ? `; the window resets in ${reset} s` : ''}.`
                  : `Reddit returned HTTP ${status} for ${context}.`;
    return reason;
}

/**
 * Format posts for the model.
 * @param heading The line introducing the result.
 * @param posts The posts.
 * @param after The cursor for the next page.
 * @returns The text.
 */
export function formatPosts(
    heading: string,
    posts: readonly z.infer<typeof postSchema>[],
    after: string | null | undefined
): string {
    if (posts.length === 0) return `${heading}\nNo posts.`;
    const lines = [heading];
    posts.forEach((post, index) => {
        lines.push(
            '',
            `${index + 1}. ${post.title}${post.stickied ? ' [pinned]' : ''}${post.over_18 ? ' [NSFW]' : ''}`,
            `   r/${post.subreddit} · u/${post.author ?? '[deleted]'} · ${when(post.created_utc)}${post.link_flair_text ? ` · ${post.link_flair_text}` : ''}`,
            `   score ${post.score ?? 0}${post.upvote_ratio === undefined ? '' : ` (${Math.round(post.upvote_ratio * 100)}% upvoted)`} · ${post.num_comments ?? 0} comments · id ${post.id}`,
            `   https://www.reddit.com${post.permalink}`
        );
        if (!post.is_self && post.url) lines.push(`   links to ${post.url}`);
        if (post.selftext?.trim()) lines.push(`   ${brief(post.selftext)}`);
    });
    if (after) lines.push('', `More posts are available: after "${after}".`);
    return lines.join('\n');
}

/**
 * Flatten the comment tree, keeping its order and depth.
 * @param children The listing children.
 * @param out The accumulator.
 * @returns The same accumulator.
 */
function flatten(children: readonly { kind: string; data: object }[], out: CommentNode[] = []) {
    for (const child of children) {
        if (child.kind !== 't1') continue;
        const comment = commentSchema.parse(child.data);
        out.push({
            author: comment.author ?? '[deleted]',
            body: comment.body ?? '',
            score: comment.score ?? 0,
            depth: comment.depth ?? 0,
            created: comment.created_utc ?? 0,
        });
        const replies = listingSchema.safeParse(comment.replies);
        if (replies.success) flatten(replies.data.data.children, out);
    }
    return out;
}

const timeSchema = {
    type: 'string',
    enum: ['hour', 'day', 'week', 'month', 'year', 'all'],
    description: 'The window for sort "top" (and for search); default day for top, all for search.',
} as const;

const limitSchema = {
    type: 'integer',
    minimum: 1,
    maximum: 100,
    description: 'How many posts to return (default 25).',
} as const;

const afterSchema = {
    type: 'string',
    description: 'The `after` cursor from the previous result, to continue to the next page.',
} as const;

/**
 * The Reddit tools sharing one app-only token.
 * @param transport The fetch implementation; injectable for tests.
 * @param now The clock; injectable for tests.
 * @returns The tools.
 */
export function createTools(
    transport: typeof fetch = fetch,
    now: () => number = Date.now
): {
    readonly listing: ToolDefinition<ListingInput>;
    readonly search: ToolDefinition<SearchInput>;
    readonly comments: ToolDefinition<CommentsInput>;
} {
    let cached: { clientId: string; token: string; expiresAt: number } | undefined;

    /**
     * An app-only token for the credential, fetched when none is fresh.
     * @param values The credential values.
     * @param signal The call's abort signal.
     * @returns The token, or an error text.
     */
    async function token(
        values: z.infer<typeof credentialValues>,
        signal: AbortSignal
    ): Promise<{ token: string } | { error: string }> {
        if (cached?.clientId === values.clientId && cached.expiresAt > now() + 30_000)
            return { token: cached.token };
        const secret = values.clientSecret ?? '';
        const body = new URLSearchParams(
            secret
                ? { grant_type: 'client_credentials' }
                : {
                      grant_type: 'https://oauth.reddit.com/grants/installed_client',
                      device_id: 'DO_NOT_TRACK_THIS_DEVICE',
                  }
        );
        let response: Response;
        try {
            response = await transport(tokenUrl, {
                method: 'POST',
                headers: {
                    Authorization: `Basic ${Buffer.from(`${values.clientId}:${secret}`).toString('base64')}`,
                    'User-Agent': userAgent,
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body,
                signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
            });
        } catch (error) {
            if (signal.aborted) throw error;
            return {
                error: `Could not reach Reddit: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
        const text = await response.text();
        if (!response.ok)
            return {
                error:
                    response.status === 401
                        ? 'Reddit rejected the client ID or secret; the user can fix them in Settings.'
                        : `Reddit refused to issue a token (HTTP ${response.status}).`,
            };
        try {
            const parsed = tokenSchema.parse(JSON.parse(text));
            cached = {
                clientId: values.clientId,
                token: parsed.access_token,
                expiresAt: now() + parsed.expires_in * 1000,
            };
            return { token: parsed.access_token };
        } catch {
            return {
                error: 'Reddit refused to issue a token (the client ID or secret may be wrong).',
            };
        }
    }

    /**
     * GET an API path and parse the JSON.
     * @param path The path and query.
     * @param what What is being read, for error text.
     * @param credential The credential values from the call.
     * @param signal The call's abort signal.
     * @returns The JSON, or an error text.
     */
    async function get(
        path: string,
        what: string,
        credential: { values: unknown } | undefined,
        signal: AbortSignal
    ): Promise<{ json: unknown } | { error: string }> {
        if (!credential) return { error: 'No Reddit API app is configured.' };
        const auth = await token(credentialValues.parse(credential.values), signal);
        if ('error' in auth) return auth;
        let response: Response;
        try {
            response = await transport(`${apiBase}${path}`, {
                headers: { Authorization: `Bearer ${auth.token}`, 'User-Agent': userAgent },
                signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
            });
        } catch (error) {
            if (signal.aborted) throw error;
            return {
                error: `Could not reach Reddit: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
        const text = await response.text();
        if (!response.ok) {
            if (response.status === 401) cached = undefined;
            return { error: failure(response, what) };
        }
        try {
            return { json: JSON.parse(text) };
        } catch {
            return { error: 'Reddit returned a response Whim could not read.' };
        }
    }

    /**
     * Parse a listing into posts.
     * @param json The response.
     * @returns The posts and next cursor, or an error text.
     */
    function posts(
        json: unknown
    ):
        | { posts: z.infer<typeof postSchema>[]; after: string | null | undefined }
        | { error: string } {
        const parsed = listingSchema.safeParse(json);
        if (!parsed.success) return { error: 'Reddit returned a response Whim could not read.' };
        return {
            posts: parsed.data.data.children
                .filter(child => child.kind === 't3')
                .map(child => postSchema.parse(child.data)),
            after: parsed.data.data.after,
        };
    }

    const common = {
        readOnly: true,
        concurrencySafe: true,
        needsWorkspace: false,
        credentialType: credentialTypeId,
        access: () => [{ kind: 'network' as const, url: apiBase }],
    };

    const listing = defineTool<ListingInput>({
        ...common,
        name: 'RedditListing',
        description:
            'List posts of one subreddit in the order Reddit ranks them: hot (what is active now), new (newest first), top (best within a time window) or rising. ' +
            'Each post has its title, author, time, score, comment count, id, link and the start of its text. Pinned posts are marked. Read the discussion of a post with RedditComments.',
        inputSchema: {
            type: 'object',
            properties: {
                subreddit: {
                    type: 'string',
                    pattern: '^(r/)?[A-Za-z0-9_]{2,21}$',
                    description: 'The subreddit name, with or without r/.',
                },
                sort: {
                    type: 'string',
                    enum: ['hot', 'new', 'top', 'rising'],
                    description: 'Ranking (default hot).',
                },
                time: timeSchema,
                limit: limitSchema,
                after: afterSchema,
            },
            required: ['subreddit'],
            additionalProperties: false,
        },
        async execute(input, context) {
            const name = input.subreddit.replace(/^r\//, '');
            const sort = input.sort ?? 'hot';
            const query = new URLSearchParams({ limit: String(input.limit ?? 25), raw_json: '1' });
            if (sort === 'top') query.set('t', input.time ?? 'day');
            if (input.after) query.set('after', input.after);
            const result = await get(
                `/r/${name}/${sort}?${query}`,
                `subreddit r/${name}`,
                context.credential,
                context.signal
            );
            if ('error' in result) return { content: result.error, isError: true };
            const parsed = posts(result.json);
            if ('error' in parsed) return { content: parsed.error, isError: true };
            return {
                content: formatPosts(
                    `r/${name}, ${sort}${sort === 'top' ? ` of the ${input.time ?? 'day'}` : ''}:`,
                    parsed.posts,
                    parsed.after
                ),
            };
        },
    });

    const search = defineTool<SearchInput>({
        ...common,
        name: 'RedditSearch',
        description:
            'Search Reddit posts by words, across all of Reddit or inside one subreddit. ' +
            'The query accepts Reddit search syntax such as title:word, author:name, "exact phrase", OR and -exclude. Reddit search is shallow and can miss posts; for a subreddit’s recent activity use RedditListing.',
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 512,
                    description: 'The search query.',
                },
                subreddit: {
                    type: 'string',
                    pattern: '^(r/)?[A-Za-z0-9_]{2,21}$',
                    description: 'Search only this subreddit; omit to search all of Reddit.',
                },
                sort: {
                    type: 'string',
                    enum: ['relevance', 'new', 'top', 'comments'],
                    description: 'Ranking (default relevance).',
                },
                time: timeSchema,
                limit: limitSchema,
                after: afterSchema,
            },
            required: ['query'],
            additionalProperties: false,
        },
        async execute(input, context) {
            const name = input.subreddit?.replace(/^r\//, '');
            const query = new URLSearchParams({
                q: input.query,
                sort: input.sort ?? 'relevance',
                t: input.time ?? 'all',
                limit: String(input.limit ?? 25),
                type: 'link',
                raw_json: '1',
            });
            if (name) query.set('restrict_sr', '1');
            if (input.after) query.set('after', input.after);
            const result = await get(
                `${name ? `/r/${name}` : ''}/search?${query}`,
                'search',
                context.credential,
                context.signal
            );
            if ('error' in result) return { content: result.error, isError: true };
            const parsed = posts(result.json);
            if ('error' in parsed) return { content: parsed.error, isError: true };
            return {
                content: formatPosts(
                    `Posts matching "${input.query}"${name ? ` in r/${name}` : ''}, by ${input.sort ?? 'relevance'}:`,
                    parsed.posts,
                    parsed.after
                ),
            };
        },
    });

    const comments = defineTool<CommentsInput>({
        ...common,
        name: 'RedditComments',
        description:
            'Read the discussion under one Reddit post: its comments in thread order, each with author, score and depth. ' +
            'Collapsed "load more" branches are not expanded, so a very long thread is only partly shown.',
        inputSchema: {
            type: 'object',
            properties: {
                post: {
                    type: 'string',
                    pattern: '^[a-z0-9]{4,10}$',
                    description: 'The post id from a listing (without the t3_ prefix).',
                },
                sort: {
                    type: 'string',
                    enum: ['confidence', 'top', 'new', 'controversial'],
                    description: 'Comment ranking (default confidence, Reddit’s best).',
                },
                limit: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 200,
                    description: 'How many comments to fetch (default 50).',
                },
            },
            required: ['post'],
            additionalProperties: false,
        },
        async execute(input, context) {
            const query = new URLSearchParams({
                sort: input.sort ?? 'confidence',
                limit: String(input.limit ?? 50),
                raw_json: '1',
            });
            const result = await get(
                `/comments/${input.post}?${query}`,
                `post ${input.post}`,
                context.credential,
                context.signal
            );
            if ('error' in result) return { content: result.error, isError: true };
            const parts = z.tuple([listingSchema, listingSchema]).safeParse(result.json);
            if (!parts.success)
                return {
                    content: 'Reddit returned a response Whim could not read.',
                    isError: true,
                };
            const [postPart, commentPart] = parts.data;
            const post = posts(postPart);
            if ('error' in post) return { content: post.error, isError: true };
            const nodes = flatten(commentPart.data.children);
            const lines = [
                formatPosts('Post:', post.posts, undefined),
                '',
                `${nodes.length} comments:`,
            ];
            for (const node of nodes)
                lines.push(
                    `${'  '.repeat(node.depth)}- u/${node.author} · score ${node.score} · ${when(node.created)}: ${brief(node.body)}`
                );
            return { content: lines.join('\n') };
        },
    });

    return { listing, search, comments };
}
