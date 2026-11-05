import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApplicationError } from '@whimkit/core/contracts';

import { createChatAdapter, credentialTypeId } from './chat.js';

import type { FrozenChatCard } from '@whimkit/core/contracts';
import type { ChatEvent, ChatRequest } from '@whimkit/core/plugin';

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
 * @param request The chat request.
 * @returns Events and the thrown failure, if any.
 */
async function run(
    transport: typeof fetch,
    baseUrl?: string,
    request: ChatRequest = {
        system: 'sys',
        messages: [{ role: 'user', blocks: [{ type: 'text', text: 'hi' }] }],
        thinking: 'high',
        tools: [],
        nativeTools: [],
    }
) {
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
        for await (const event of session.stream(request, new AbortController().signal))
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

    it('declares tools, replays calls and results, and reports tool calls', async () => {
        const search = {
            type: 'web_search_call',
            id: 'ws_1',
            status: 'completed',
            action: {
                type: 'search',
                query: 'whim',
                sources: [{ type: 'url', url: 'https://a.example' }],
            },
        };
        const extract = {
            type: 'web_extractor_call',
            id: 'we_1',
            status: 'completed',
            goal: 'read it',
            urls: ['https://a.example'],
            output: 'A summary.',
        };
        const { transport, requests } = fakeFetch(() =>
            sse([
                { type: 'response.output_item.done', item: search },
                { type: 'response.output_item.done', item: extract },
                {
                    type: 'response.output_item.done',
                    item: {
                        type: 'function_call',
                        id: 'fc_1',
                        call_id: 'call_2',
                        name: 'Read',
                        arguments: '{"path":"b"}',
                    },
                },
                { type: 'response.completed', response: { status: 'completed' } },
            ])
        );
        const adapter = '@whimkit/plugin-dashscope#responses';
        const result = await run(transport, undefined, {
            system: 'sys',
            messages: [
                { role: 'user', blocks: [{ type: 'text', text: 'read a' }] },
                {
                    role: 'assistant',
                    blocks: [
                        {
                            type: 'native_tool_call',
                            adapter,
                            format: 1,
                            tool: 'web_search',
                            status: 'completed',
                            data: search,
                        },
                        {
                            type: 'native_tool_call',
                            adapter,
                            format: 1,
                            tool: 'web_fetch',
                            status: 'completed',
                            urls: ['https://a.example'],
                            data: extract,
                        },
                        { type: 'text', text: 'Reading.' },
                        {
                            type: 'tool_call',
                            callId: 'call_1',
                            name: 'Read',
                            arguments: '{"path":"a"}',
                        },
                    ],
                },
                { role: 'tool', callId: 'call_1', status: 'success', content: 'file a' },
            ],
            tools: [{ name: 'Read', description: 'Read a file.', inputSchema: { type: 'object' } }],
            nativeTools: ['web_search', 'web_fetch'],
        });
        assert.deepEqual(requests[0].body, {
            model: 'qwen3.8-flash',
            instructions: 'sys',
            input: [
                { role: 'user', content: [{ type: 'input_text', text: 'read a' }] },
                search,
                {
                    role: 'assistant',
                    content: [
                        { type: 'output_text', text: 'Fetched https://a.example:\nA summary.' },
                    ],
                },
                { role: 'assistant', content: [{ type: 'output_text', text: 'Reading.' }] },
                {
                    type: 'function_call',
                    call_id: 'call_1',
                    name: 'Read',
                    arguments: '{"path":"a"}',
                },
                { type: 'function_call_output', call_id: 'call_1', output: 'file a' },
            ],
            tools: [
                { type: 'web_search' },
                { type: 'web_extractor' },
                {
                    type: 'function',
                    name: 'Read',
                    description: 'Read a file.',
                    parameters: { type: 'object' },
                },
            ],
            stream: true,
            store: false,
            max_output_tokens: 100,
        });
        assert.deepEqual(result.events, [
            {
                type: 'native-tool-call',
                format: 1,
                tool: 'web_search',
                status: 'completed',
                query: 'whim',
                urls: ['https://a.example'],
                data: search,
            },
            {
                type: 'native-tool-call',
                format: 1,
                tool: 'web_fetch',
                status: 'completed',
                query: 'read it',
                urls: ['https://a.example'],
                data: extract,
            },
            { type: 'tool-call', callId: 'call_2', name: 'Read', arguments: '{"path":"b"}' },
            { type: 'completed', usage: {} },
        ]);
    });

    it('drops web_extractor when thinking is off', async () => {
        const { transport, requests } = fakeFetch(() =>
            sse([{ type: 'response.completed', response: { status: 'completed' } }])
        );
        const messages: ChatRequest['messages'] = [
            { role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
        ];
        const base = {
            system: 'sys',
            messages,
            tools: [],
            nativeTools: ['web_search', 'web_fetch'],
        };
        await run(transport, undefined, { ...base, thinking: 'off' });
        await run(transport, undefined, { ...base, thinking: 'low' });
        assert.deepEqual(
            requests.map(request => {
                const body = request.body as { reasoning: unknown; tools: unknown };
                return [body.reasoning, body.tools];
            }),
            [
                [{ effort: 'none' }, [{ type: 'web_search' }]],
                [{ effort: 'low' }, [{ type: 'web_search' }, { type: 'web_extractor' }]],
            ]
        );
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
