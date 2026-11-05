import { defineTool } from '@whimkit/core/plugin';
import { z } from 'zod';

import type { ToolDefinition } from '@whimkit/core/plugin';

export const pluginId = '@whimkit/plugin-tavily';
export const credentialTypeId = `${pluginId}#api-key`;
const endpoint = 'https://api.tavily.com/search';
const timeoutMs = 30_000;

export const credentialSchema = {
    type: 'object',
    title: 'Tavily API key',
    required: ['apiKey'],
    additionalProperties: false,
    properties: {
        apiKey: {
            type: 'string',
            title: 'API key',
            writeOnly: true,
            format: 'password',
            minLength: 1,
        },
    },
} as const;

export interface SearchInput {
    readonly query: string;
    readonly max_results?: number;
    readonly topic?: 'general' | 'news';
    readonly time_range?: 'day' | 'week' | 'month' | 'year';
}

const credentialValues = z.object({ apiKey: z.string().min(1) });

const responseSchema = z.looseObject({
    results: z.array(
        z.looseObject({
            title: z.string().nullish(),
            url: z.string(),
            content: z.string().nullish(),
            published_date: z.string().nullish(),
        })
    ),
});

const errorSchema = z
    .looseObject({
        detail: z.union([
            z.string(),
            z.looseObject({ error: z.string().optional() }),
            z.array(z.unknown()),
        ]),
    })
    .partial();

/**
 * The failure text for an HTTP error, following Tavily's documented status codes.
 * @param status The HTTP status.
 * @param body The response body.
 * @param retryAfter The Retry-After header.
 * @returns A message for the model.
 */
function failure(status: number, body: string, retryAfter: string | null): string {
    let detail = body.slice(0, 300);
    try {
        const parsed = errorSchema.parse(JSON.parse(body)).detail;
        if (typeof parsed === 'string') detail = parsed;
        else if (parsed && !Array.isArray(parsed) && parsed.error) detail = parsed.error;
    } catch {
        // Keep the raw text.
    }
    const reason =
        status === 401
            ? 'The Tavily API key is missing or invalid; the user can fix it in Settings.'
            : status === 429
              ? `Tavily is rate limiting searches${retryAfter ? `; retry after ${retryAfter} s` : ''}.`
              : status === 432 || status === 433
                ? "The Tavily account's plan or spending limit is used up."
                : `Tavily returned HTTP ${status}.`;
    return detail ? `${reason} Detail: ${detail}` : reason;
}

/**
 * Format results for the model: title, URL, and the snippet Tavily extracted.
 * @param query The query.
 * @param results The results.
 * @returns The text.
 */
function format(query: string, results: z.infer<typeof responseSchema>['results']): string {
    if (results.length === 0) return `No results for "${query}".`;
    const lines = [`Results for "${query}":`];
    results.forEach((result, index) => {
        lines.push(
            '',
            `${index + 1}. ${result.title?.trim() || result.url}`,
            `   ${result.url}${result.published_date ? ` (${result.published_date})` : ''}`
        );
        if (result.content?.trim()) lines.push(`   ${result.content.trim().replace(/\s+/g, ' ')}`);
    });
    lines.push(
        '',
        'Snippets are excerpts chosen by the search service; open a page with WebFetch before relying on it.'
    );
    return lines.join('\n');
}

/**
 * The WebSearch tool backed by Tavily. It implements the standard `web_search` id, so models
 * whose provider searches natively never see it.
 * @param transport The fetch implementation; injectable for tests.
 * @returns The tool.
 */
export function createSearchTool(transport: typeof fetch = fetch): ToolDefinition<SearchInput> {
    return defineTool<SearchInput>({
        name: 'WebSearch',
        description:
            'Search the web. Returns ranked results, each with title, URL, and a relevant excerpt. ' +
            'Use topic "news" for recent events and time_range to limit how old results may be. ' +
            'Read a promising result with WebFetch before relying on it.',
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 400,
                    description: 'The search query.',
                },
                max_results: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 10,
                    description: 'How many results to return (default 5).',
                },
                topic: {
                    type: 'string',
                    enum: ['general', 'news'],
                    description: 'Default general.',
                },
                time_range: {
                    type: 'string',
                    enum: ['day', 'week', 'month', 'year'],
                    description: 'Only results from this recent period.',
                },
            },
            required: ['query'],
            additionalProperties: false,
        },
        readOnly: true,
        concurrencySafe: true,
        needsWorkspace: false,
        standard: 'web_search',
        credentialType: credentialTypeId,
        access: () => [{ kind: 'network', url: endpoint }],
        async execute(input, context) {
            if (!context.credential)
                return { content: 'No Tavily API key is configured.', isError: true };
            const { apiKey } = credentialValues.parse(context.credential.values);
            const signal = AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)]);
            let response: Response;
            try {
                response = await transport(endpoint, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        query: input.query,
                        search_depth: 'basic',
                        max_results: input.max_results ?? 5,
                        topic: input.topic ?? 'general',
                        ...(input.time_range ? { time_range: input.time_range } : {}),
                    }),
                    signal,
                });
            } catch (error) {
                if (context.signal.aborted) throw error;
                return {
                    content: `Could not reach Tavily: ${error instanceof Error ? error.message : String(error)}`,
                    isError: true,
                };
            }
            const body = await response.text();
            if (!response.ok)
                return {
                    content: failure(response.status, body, response.headers.get('retry-after')),
                    isError: true,
                };
            let parsed;
            try {
                parsed = responseSchema.parse(JSON.parse(body));
            } catch {
                return {
                    content: 'Tavily returned a response Whim could not read.',
                    isError: true,
                };
            }
            return { content: format(input.query, parsed.results) };
        },
    });
}
