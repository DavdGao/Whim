import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTools, credentialTypeId } from './api.js';

/**
 * A fetch that answers by URL path and records every request.
 * @param routes Path prefix → response.
 * @returns The transport and recorded requests.
 */
function fakeFetch(routes: Record<string, { status?: number; body: unknown }>) {
    const requests: { url: string; authorization: string | null; body: string | null }[] = [];
    const transport = (async (url: string | URL | Request, init?: RequestInit) => {
        const parsed = new URL(String(url));
        requests.push({
            url: String(url),
            authorization: new Headers(init?.headers).get('authorization'),
            body: init?.body ? String(init.body) : null,
        });
        const route = routes[parsed.pathname];
        assert.ok(route, `unexpected ${parsed.pathname}`);
        return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
    }) as typeof fetch;
    return { transport, requests };
}

const credential = (values: Record<string, string>) => ({
    signal: new AbortController().signal,
    sessionId: 's',
    callId: 'c',
    output: () => {},
    knownFiles: new Map(),
    credential: { id: 'k', typeId: credentialTypeId, values },
});

const token = { body: { access_token: 'at', expires_in: 3600 } };
const post = {
    kind: 't3',
    data: {
        id: 'abc123',
        name: 't3_abc123',
        title: 'A new agent framework',
        author: 'ada',
        subreddit: 'LocalLLaMA',
        score: 120,
        upvote_ratio: 0.93,
        num_comments: 14,
        created_utc: 1_793_000_000,
        permalink: '/r/LocalLLaMA/comments/abc123/a_new_agent_framework/',
        url: 'https://github.com/x/y',
        is_self: false,
        selftext: '',
        stickied: false,
    },
};

describe('Reddit tools', () => {
    it('lists a subreddit with a client-credentials token that is reused', async () => {
        const { transport, requests } = fakeFetch({
            '/api/v1/access_token': token,
            '/r/LocalLLaMA/top': { body: { data: { after: 't3_abc123', children: [post] } } },
        });
        const { listing } = createTools(transport, () => 0);
        const input = { subreddit: 'r/LocalLLaMA', sort: 'top', time: 'week' } as const;
        const ctx = credential({ clientId: 'id', clientSecret: 'secret' });
        const output = await listing.execute(input, ctx);
        await listing.execute(input, ctx);
        assert.equal(requests.filter(r => r.url.includes('access_token')).length, 1);
        assert.equal(requests[0]?.body, 'grant_type=client_credentials');
        assert.equal(
            requests[0]?.authorization,
            `Basic ${Buffer.from('id:secret').toString('base64')}`
        );
        const url = new URL(requests[1]?.url ?? '');
        assert.equal(url.searchParams.get('t'), 'week');
        assert.equal(requests[1]?.authorization, 'Bearer at');
        assert.deepEqual(output, {
            content: [
                'r/LocalLLaMA, top of the week:',
                '',
                '1. A new agent framework',
                '   r/LocalLLaMA · u/ada · 2026-10-26T07:33Z',
                '   score 120 (93% upvoted) · 14 comments · id abc123',
                '   https://www.reddit.com/r/LocalLLaMA/comments/abc123/a_new_agent_framework/',
                '   links to https://github.com/x/y',
                '',
                'More posts are available: after "t3_abc123".',
            ].join('\n'),
        });
    });

    it('uses the installed-client grant when there is no secret', async () => {
        const { transport, requests } = fakeFetch({
            '/api/v1/access_token': token,
            '/search': { body: { data: { after: null, children: [] } } },
        });
        const { search } = createTools(transport, () => 0);
        const output = await search.execute({ query: 'whim' }, credential({ clientId: 'id' }));
        assert.match(requests[0]?.body ?? '', /installed_client/);
        assert.deepEqual(output, { content: 'Posts matching "whim", by relevance:\nNo posts.' });
    });

    it('reads a thread in order with depth, skipping collapsed branches', async () => {
        const reply = {
            kind: 't1',
            data: {
                author: 'bob',
                body: 'I disagree',
                score: 3,
                depth: 1,
                created_utc: 1_793_000_100,
                replies: '',
            },
        };
        const top = {
            kind: 't1',
            data: {
                author: 'cy',
                body: 'Nice\nwork',
                score: 9,
                depth: 0,
                created_utc: 1_793_000_050,
                replies: { data: { children: [reply, { kind: 'more', data: {} }] } },
            },
        };
        const { transport } = fakeFetch({
            '/api/v1/access_token': token,
            '/comments/abc123': {
                body: [
                    { data: { children: [post] } },
                    { data: { children: [top, { kind: 'more', data: {} }] } },
                ],
            },
        });
        const { comments } = createTools(transport, () => 0);
        const output = await comments.execute({ post: 'abc123' }, credential({ clientId: 'id' }));
        assert.ok(!('isError' in output && output.isError));
        assert.match(
            String(output.content),
            /2 comments:\n- u\/cy · score 9 · [^ ]+Z: Nice work\n {2}- u\/bob · score 3/
        );
    });

    it('explains a rejected secret and a private subreddit', async () => {
        const rejected = createTools(
            fakeFetch({ '/api/v1/access_token': { status: 401, body: {} } }).transport,
            () => 0
        );
        assert.deepEqual(
            await rejected.listing.execute(
                { subreddit: 'abc' },
                credential({ clientId: 'id', clientSecret: 'x' })
            ),
            {
                content:
                    'Reddit rejected the client ID or secret; the user can fix them in Settings.',
                isError: true,
            }
        );
        const closed = createTools(
            fakeFetch({ '/api/v1/access_token': token, '/r/abc/hot': { status: 403, body: {} } })
                .transport,
            () => 0
        );
        assert.deepEqual(
            await closed.listing.execute({ subreddit: 'abc' }, credential({ clientId: 'id' })),
            {
                content:
                    'Reddit refused subreddit r/abc: the subreddit is private, quarantined, banned, or the app lacks access.',
                isError: true,
            }
        );
    });
});
