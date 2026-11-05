import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSearchTool, credentialTypeId } from './search.js';

/**
 * A fetch that records requests and answers with one response.
 * @param status HTTP status.
 * @param body JSON body.
 * @param headers Response headers.
 * @returns The transport and recorded requests.
 */
function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
    const requests: { url: string; body: unknown; authorization: string | null }[] = [];
    const transport = (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({
            url: String(url),
            body: JSON.parse(String(init?.body)),
            authorization: new Headers(init?.headers).get('authorization'),
        });
        return new Response(JSON.stringify(body), { status, headers });
    }) as typeof fetch;
    return { transport, requests };
}

const context = {
    signal: new AbortController().signal,
    sessionId: 's',
    callId: 'c',
    output: () => {},
    credential: { id: 'k', typeId: credentialTypeId, values: { apiKey: 'tvly-test' } },
};

describe('Tavily WebSearch', () => {
    it('searches with the key and formats results', async () => {
        const { transport, requests } = fakeFetch(200, {
            query: 'whim',
            results: [
                {
                    title: 'Whim',
                    url: 'https://a.example',
                    content: 'An  agent\nworkspace.',
                    score: 0.9,
                },
                {
                    title: '',
                    url: 'https://b.example',
                    content: null,
                    published_date: '2026-11-01',
                },
            ],
        });
        const tool = createSearchTool(transport);
        assert.equal(tool.standard, 'web_search');
        assert.equal(tool.credentialType, credentialTypeId);
        const output = await tool.execute(
            { query: 'whim', topic: 'news', time_range: 'week' },
            context
        );
        assert.deepEqual(requests, [
            {
                url: 'https://api.tavily.com/search',
                authorization: 'Bearer tvly-test',
                body: {
                    query: 'whim',
                    search_depth: 'basic',
                    max_results: 5,
                    topic: 'news',
                    time_range: 'week',
                },
            },
        ]);
        assert.deepEqual(output, {
            content: [
                'Results for "whim":',
                '',
                '1. Whim',
                '   https://a.example',
                '   An agent workspace.',
                '',
                '2. https://b.example',
                '   https://b.example (2026-11-01)',
                '',
                'Snippets are excerpts chosen by the search service; open a page with WebFetch before relying on it.',
            ].join('\n'),
        });
    });

    it('reports documented failures as errors', async () => {
        const unauthorized = await createSearchTool(
            fakeFetch(401, { detail: { error: 'Unauthorized: missing or invalid API key.' } })
                .transport
        ).execute({ query: 'x' }, context);
        assert.deepEqual(unauthorized, {
            content:
                'The Tavily API key is missing or invalid; the user can fix it in Settings. Detail: Unauthorized: missing or invalid API key.',
            isError: true,
        });
        const limited = await createSearchTool(
            fakeFetch(429, { detail: { error: 'Too many requests.' } }, { 'retry-after': '12' })
                .transport
        ).execute({ query: 'x' }, context);
        assert.deepEqual(limited, {
            content:
                'Tavily is rate limiting searches; retry after 12 s. Detail: Too many requests.',
            isError: true,
        });
    });
});
