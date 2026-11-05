import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createFetchTool } from './fetch-tool.js';

import type { FetchLike } from './http.js';
import type { ToolContext } from '@whimkit/core/plugin';
import type { Server } from 'node:http';

const MiB = 1024 * 1024;

/**
 * Build a tool context.
 * @param signal Cancellation signal.
 * @returns The context.
 */
function contextWith(signal: AbortSignal = new AbortController().signal): ToolContext {
    return { signal, sessionId: 's', callId: 'c', output: () => undefined, knownFiles: new Map() };
}

/**
 * A fetch that never answers until its signal aborts.
 * @param input Ignored.
 * @param _input
 * @param init Request init carrying the signal.
 * @returns A promise rejecting with the abort reason.
 */
const hangingFetch: FetchLike = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });

describe('WebFetch', () => {
    let server: Server;
    let base: string;
    let alt: string;
    let seenHeaders: Record<string, string | string[] | undefined> = {};

    before(async () => {
        server = createServer((request, response) => {
            seenHeaders = request.headers;
            const path = request.url ?? '/';
            if (path === '/html') {
                response.setHeader('content-type', 'text/html; charset=utf-8');
                response.end(
                    '<html><head><title>Hello Page</title><style>p{}</style></head><body>' +
                        '<script>alert(1)</script><noscript>nojs</noscript><svg><text>icon</text></svg>' +
                        '<h1>Heading</h1><p>Some <b>bold</b> text and <a href="/x">a link</a>.</p></body></html>'
                );
            } else if (path === '/json') {
                response.setHeader('content-type', 'application/json');
                response.end('{"a":1}');
            } else if (path === '/png') {
                response.setHeader('content-type', 'image/png');
                response.end(Buffer.alloc(100));
            } else if (path === '/big') {
                response.setHeader('content-type', 'text/plain');
                response.end(Buffer.alloc(6 * MiB, 'a'));
            } else if (path === '/same') {
                response.writeHead(302, { location: '/html' });
                response.end();
            } else if (path === '/loop') {
                response.writeHead(302, { location: '/loop' });
                response.end();
            } else if (path === '/cross') {
                response.writeHead(301, { location: `${alt}/elsewhere` });
                response.end();
            } else {
                response.statusCode = 404;
                response.setHeader('content-type', 'text/plain');
                response.end('missing');
            }
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        assert.ok(address !== null && typeof address === 'object');
        const port = address.port;
        base = `http://127.0.0.1:${port}`;
        alt = `http://localhost:${port}`;
    });

    after(() => {
        server.close();
    });

    /**
     * Build the tool with the real fetch.
     * @returns The WebFetch tool.
     */
    function tool(): ReturnType<typeof createFetchTool> {
        return createFetchTool({ fetch, version: '9.9.9' });
    }

    it('declares network access and the standard id', () => {
        const webFetch = tool();
        assert.deepEqual(webFetch.access({ url: 'https://a.test/p' }, {}), [
            { kind: 'network', url: 'https://a.test/p' },
        ]);
        assert.equal(webFetch.standard, 'web_fetch');
        assert.equal(webFetch.needsWorkspace, false);
        assert.equal(webFetch.backgroundAfterMs, undefined);
    });

    it('converts HTML to Markdown, falls back from https to http, and sends headers', async () => {
        const output = await tool().execute(
            { url: `${base}/html`, prompt: 'the heading' },
            contextWith()
        );
        assert.equal(output.isError, false);
        assert.ok(output.content.startsWith('Requested focus: the heading\nURL: '));
        assert.match(output.content, /Final URL: http:\/\/127\.0\.0\.1:\d+\/html\nStatus: 200\n/);
        assert.match(output.content, /Title: Hello Page/);
        assert.match(output.content, /# Heading/);
        assert.match(output.content, /Some \*\*bold\*\* text and \[a link\]\(\/x\)\./);
        assert.doesNotMatch(output.content, /alert|nojs|icon|p\{\}/);
        assert.equal(seenHeaders['user-agent'], 'Whim/9.9.9 (+https://github.com/DavdGao/Whim)');
        assert.equal(
            seenHeaders['accept'],
            'text/html, text/markdown, text/plain, application/json;q=0.9, */*;q=0.1'
        );
    });

    it('returns text types verbatim', async () => {
        const output = await tool().execute({ url: `${base}/json` }, contextWith());
        assert.match(output.content, /Content-Type: application\/json\n\n\{"a":1\}$/);
    });

    it('reports binary types as metadata only', async () => {
        const output = await tool().execute({ url: `${base}/png` }, contextWith());
        assert.equal(output.isError, true);
        assert.match(
            output.content,
            /Content-Type: image\/png\nSize: 100 bytes\n\nThis content type \(image\/png\) cannot be read/
        );
    });

    it('caps the body at 5 MiB and notes truncation', async () => {
        const output = await tool().execute({ url: `${base}/big` }, contextWith());
        assert.match(output.content, /Note: the body was truncated at 5242880 bytes\./);
        const body = output.content.slice(output.content.indexOf('\n\n') + 2);
        assert.equal(body.length, 5 * MiB);
    });

    it('follows same-host redirects and bounds them', async () => {
        const followed = await tool().execute({ url: `${base}/same` }, contextWith());
        assert.match(followed.content, /Final URL: http:\/\/127\.0\.0\.1:\d+\/html/);
        const looped = await tool().execute({ url: `${base}/loop` }, contextWith());
        assert.deepEqual(looped, { content: 'Too many redirects (more than 5).', isError: true });
    });

    it('does not follow cross-host redirects', async () => {
        const output = await tool().execute({ url: `${base}/cross` }, contextWith());
        assert.equal(output.isError, undefined);
        assert.match(output.content, /Status: 301/);
        assert.ok(
            output.content.includes(`Redirected to a different host (localhost) and not followed.`)
        );
        assert.ok(output.content.endsWith(`${alt}/elsewhere`));
    });

    it('marks HTTP errors', async () => {
        const output = await tool().execute({ url: `${base}/nope` }, contextWith());
        assert.equal(output.isError, true);
        assert.match(output.content, /Status: 404[\s\S]*missing$/);
    });

    it('rejects unsupported schemes', async () => {
        const output = await tool().execute({ url: 'file:///etc/passwd' }, contextWith());
        assert.equal(output.isError, true);
    });

    it('times out and honors cancellation', async () => {
        const webFetch = createFetchTool({
            fetch: hangingFetch,
            version: '1',
            timeoutMs: 20,
        });
        const timedOut = await webFetch.execute({ url: 'https://slow.test/' }, contextWith());
        assert.deepEqual(timedOut, {
            content: 'Request timed out after 20 ms: https://slow.test/',
            isError: true,
        });

        const controller = new AbortController();
        const pending = webFetch.execute(
            { url: 'https://slow.test/' },
            contextWith(controller.signal)
        );
        controller.abort(new Error('stopped'));
        await assert.rejects(pending, /stopped/);
    });
});
