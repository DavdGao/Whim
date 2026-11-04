import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApplicationError } from '@whimkit/core/contracts';

import { createChatAdapter, credentialTypeId } from './chat.js';

import type { FrozenChatCard } from '@whimkit/core/contracts';
import type { ChatEvent } from '@whimkit/core/plugin';

const card: FrozenChatCard = {
    id: 'dashscope/qwen3.8-flash',
    revision: 1,
    adapter: '@whimkit/plugin-dashscope#responses',
    model: 'qwen3.8-flash',
    name: 'Qwen3.8 Flash',
    contextWindow: 1000,
    maxOutputTokens: 100,
    input: { 'text/plain': {} },
    output: ['text/plain'],
    thinking: { levels: ['off', 'high'], default: 'high' },
    nativeTools: [],
    options: { effort: { high: 'xhigh' } },
};

/**
 * Build a fake fetch that records requests and returns a fixed response.
 * @param respond Produces the response.
 * @returns The fake transport and its recorded requests.
 */
function fakeFetch(respond: () => Response) {
    const requests: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const transport = (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({
            url: String(url),
            body: JSON.parse(String(init?.body)),
            headers: Object.fromEntries(new Headers(init?.headers).entries()),
        });
        return respond();
    }) as typeof fetch;
    return { transport, requests };
}

/**
 * An SSE response from frames.
 * @param frames Event objects.
 * @param complete Whether the stream ends with a completion event.
 * @returns The response.
 */
function sse(frames: unknown[]): Response {
    return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
    });
}

/**
 * Run one attempt and collect its events or failure.
 * @param transport The fake transport.
 * @param baseUrl Optional credential base URL.
 * @returns Events and the thrown failure, if any.
 */
async function run(transport: typeof fetch, baseUrl?: string) {
    const session = createChatAdapter(transport).open({
        card,
        credential: {
            id: 'c',
            typeId: credentialTypeId,
            values: { apiKey: 'sk-test', ...(baseUrl ? { baseUrl } : {}) },
        },
    });
    const events: ChatEvent[] = [];
    try {
        for await (const event of session.stream(
            {
                system: 'sys',
                messages: [{ role: 'user', blocks: [{ type: 'text', text: 'hi' }] }],
                thinking: 'high',
            },
            new AbortController().signal
        ))
            events.push(event);
        return { events };
    } catch (error) {
        assert.ok(error instanceof ApplicationError);
        return { events, failure: error.failure };
    }
}

describe('DashScope Responses adapter', () => {
    it('sends a stateless request and streams text', async () => {
        const { transport, requests } = fakeFetch(() =>
            sse([
                { type: 'response.output_text.delta', delta: 'Hello' },
                {
                    type: 'response.completed',
                    response: { status: 'completed', usage: { input_tokens: 4, output_tokens: 1 } },
                },
            ])
        );
        const result = await run(transport, 'https://example.com/compatible-mode/v1/');
        assert.deepEqual(result.events, [
            { type: 'text-delta', text: 'Hello' },
            { type: 'completed', usage: { inputTokens: 4, outputTokens: 1 } },
        ]);
        assert.equal(requests[0].url, 'https://example.com/compatible-mode/v1/responses');
        assert.equal(requests[0].headers.authorization, 'Bearer sk-test');
        assert.deepEqual(requests[0].body, {
            model: 'qwen3.8-flash',
            instructions: 'sys',
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
            stream: true,
            store: false,
            max_output_tokens: 100,
            reasoning: { effort: 'xhigh' },
        });
    });

    it('maps HTTP failures with provider detail', async () => {
        const unauthorized = await run(
            fakeFetch(
                () =>
                    new Response(
                        JSON.stringify({
                            code: 'InvalidApiKey',
                            message: 'Invalid API-key provided.',
                            request_id: 'r1',
                        }),
                        {
                            status: 401,
                        }
                    )
            ).transport
        );
        assert.deepEqual(unauthorized.failure, {
            category: 'authentication',
            retry: { kind: 'after-change', change: 'credential' },
            outcome: 'rejected',
            detail: {
                provider: 'dashscope',
                status: 401,
                code: 'InvalidApiKey',
                message: 'Invalid API-key provided.',
                requestId: 'r1',
            },
        });
        const throttled = await run(
            fakeFetch(
                () =>
                    new Response(JSON.stringify({ code: 'Throttling.RateQuota' }), {
                        status: 429,
                        headers: { 'retry-after': '2' },
                    })
            ).transport
        );
        assert.deepEqual(throttled.failure?.retry, { kind: 'backoff', afterMs: 2000 });
        assert.equal(throttled.failure?.category, 'rate-limited');
    });

    it('fails a stream that ends without completion as partial transport failure', async () => {
        const result = await run(
            fakeFetch(() => sse([{ type: 'response.output_text.delta', delta: 'Hal' }])).transport
        );
        assert.deepEqual(result.events, [{ type: 'text-delta', text: 'Hal' }]);
        assert.equal(result.failure?.category, 'transport');
        assert.equal(result.failure?.outcome, 'partial');
        assert.deepEqual(result.failure?.retry, { kind: 'backoff' });
    });
});
