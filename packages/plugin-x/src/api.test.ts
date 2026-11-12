import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSearchTool, createUserPostsTool, credentialTypeId } from './api.js';

/**
 * A fetch that answers each request in turn and records the URLs.
 * @param responses The responses, in order.
 * @returns The transport and recorded requests.
 */
function fakeFetch(
    ...responses: { status?: number; body: unknown; headers?: Record<string, string> }[]
) {
    const requests: { url: string; authorization: string | null }[] = [];
    const transport = (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({
            url: String(url),
            authorization: new Headers(init?.headers).get('authorization'),
        });
        const next = responses.shift();
        assert.ok(next, 'unexpected request');
        return new Response(JSON.stringify(next.body), {
            status: next.status ?? 200,
            headers: next.headers,
        });
    }) as typeof fetch;
    return { transport, requests };
}

const context = {
    signal: new AbortController().signal,
    sessionId: 's',
    callId: 'c',
    output: () => {},
    knownFiles: new Map(),
    credential: { id: 'k', typeId: credentialTypeId, values: { bearerToken: 'tok' } },
};

describe('XSearch', () => {
    it('searches recent posts and formats authors, counts and the next page', async () => {
        const { transport, requests } = fakeFetch({
            body: {
                data: [
                    {
                        id: '1',
                        text: 'short',
                        note_tweet: { text: 'the long\nversion' },
                        author_id: 'u1',
                        created_at: '2026-11-11T10:00:00.000Z',
                        public_metrics: {
                            like_count: 5,
                            retweet_count: 1,
                            reply_count: 2,
                            quote_count: 0,
                        },
                        referenced_tweets: [{ type: 'quoted', id: '9' }],
                    },
                ],
                includes: { users: [{ id: 'u1', username: 'ada', name: 'Ada' }] },
                meta: { result_count: 1, next_token: 'abc' },
            },
        });
        const output = await createSearchTool(transport).execute(
            { query: 'agent memory', since: '2026-11-10', max_results: 10 },
            context
        );
        const url = new URL(requests[0]?.url ?? '');
        assert.equal(url.pathname, '/2/tweets/search/recent');
        assert.equal(url.searchParams.get('query'), 'agent memory');
        assert.equal(url.searchParams.get('start_time'), '2026-11-10T00:00:00Z');
        assert.equal(requests[0]?.authorization, 'Bearer tok');
        assert.deepEqual(output, {
            content: [
                'Recent posts matching "agent memory", newest first:',
                '',
                '1. @ada (Ada) · 2026-11-11T10:00:00.000Z · quoted',
                '   https://x.com/ada/status/1',
                '   the long version',
                '   likes 5 · reposts 1 · replies 2 · quotes 0',
                '',
                'More posts are available: page_token "abc".',
            ].join('\n'),
        });
    });

    it('reports rate limits and access problems as errors', async () => {
        const reset = 1_790_000_000;
        const limited = fakeFetch({
            status: 429,
            body: { title: 'Too Many Requests', detail: 'Too Many Requests' },
            headers: { 'x-rate-limit-reset': String(reset) },
        });
        const output = await createSearchTool(limited.transport).execute({ query: 'x' }, context);
        assert.deepEqual(output, {
            content: `X is rate limiting this app; the window resets at ${new Date(reset * 1000).toISOString()}. Detail: Too Many Requests`,
            isError: true,
        });
        const denied = fakeFetch({ status: 403, body: { detail: 'Forbidden' } });
        assert.deepEqual(
            await createSearchTool(denied.transport).execute({ query: 'x' }, context),
            {
                content: "The X app's access level does not allow this endpoint. Detail: Forbidden",
                isError: true,
            }
        );
    });

    it('needs a credential', async () => {
        const { credential: _credential, ...bare } = context;
        assert.deepEqual(
            await createSearchTool(fakeFetch().transport).execute({ query: 'x' }, bare),
            {
                content: 'No X bearer token is configured.',
                isError: true,
            }
        );
    });
});

describe('XUserPosts', () => {
    it('resolves the handle, then lists posts without replies and reposts', async () => {
        const { transport, requests } = fakeFetch(
            { body: { data: { id: '42', username: 'ada', name: 'Ada' } } },
            {
                body: {
                    data: [{ id: '7', text: 'hello', created_at: '2026-11-11T09:00:00.000Z' }],
                    meta: { result_count: 1 },
                },
            }
        );
        const output = await createUserPostsTool(transport).execute({ username: '@ada' }, context);
        assert.equal(new URL(requests[0]?.url ?? '').pathname, '/2/users/by/username/ada');
        const timeline = new URL(requests[1]?.url ?? '');
        assert.equal(timeline.pathname, '/2/users/42/tweets');
        assert.equal(timeline.searchParams.get('exclude'), 'replies,retweets');
        assert.deepEqual(output, {
            content: [
                'Latest posts by @ada, newest first:',
                '',
                '1. @ada (Ada) · 2026-11-11T09:00:00.000Z',
                '   https://x.com/ada/status/7',
                '   hello',
            ].join('\n'),
        });
    });

    it('says when the account does not exist', async () => {
        const { transport } = fakeFetch({
            body: { errors: [{ detail: 'Could not find user' }] },
        });
        assert.deepEqual(
            await createUserPostsTool(transport).execute({ username: 'nobody' }, context),
            {
                content: 'No X account @nobody exists.',
                isError: true,
            }
        );
    });
});
