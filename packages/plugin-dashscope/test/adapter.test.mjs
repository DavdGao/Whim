import assert from 'node:assert/strict';
import test from 'node:test';
import { card, cards, DashScopeChat, normalizeHttpFailure } from '../dist/index.js';

const request = {
    card,
    system: 'Frozen',
    messages: [
        { id: 'input', role: 'user', origin: 'user', blocks: [{ type: 'text', text: 'Hello' }] },
    ],
    purpose: 'chat',
};

test('Responses adapter sends full local context and decodes split UTF-8 SSE frames', async () => {
    let sent;
    const bytes = new globalThis.TextEncoder().encode(
        'data: {"type":"response.output_text.delta","delta":"你好"}\r\n\r\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":12,"output_tokens":2,"total_tokens":14}}}\n\n'
    );
    const model = new DashScopeChat(
        'test-key',
        'https://example.invalid/responses',
        async (_url, options) => {
            sent = JSON.parse(options.body);
            return new globalThis.Response(
                new globalThis.ReadableStream({
                    start(controller) {
                        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
                        controller.close();
                    },
                }),
                { headers: { 'content-type': 'text/event-stream' } }
            );
        }
    );
    const events = [];
    for await (const event of model.generate(request, new globalThis.AbortController().signal))
        events.push(event);
    assert.deepEqual(sent, {
        model: 'qwen3.8-max',
        instructions: 'Frozen',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }],
        stream: true,
        store: false,
        reasoning: { effort: 'xhigh' },
        max_output_tokens: 8192,
    });
    assert.deepEqual(events, [
        { type: 'text', text: '你好' },
        { type: 'completed', usage: { inputTokens: 12, outputTokens: 2, totalTokens: 14 } },
    ]);
});

test('HTTP failures distinguish temporary throttling, quota, and uncertain server outcomes', () => {
    assert.deepEqual(normalizeHttpFailure(429, { error: { code: 'RateLimitExceeded' } }, '2'), {
        category: 'rate-limited',
        retry: 'backoff',
        status: 429,
        outcome: 'rejected',
        retryAfterMs: 2000,
    });
    assert.deepEqual(normalizeHttpFailure(429, { error: { code: 'insufficient_quota' } }, null), {
        category: 'quota-exhausted',
        retry: 'after-change',
        status: 429,
        outcome: 'rejected',
    });
    assert.deepEqual(normalizeHttpFailure(503, null, null), {
        category: 'unavailable',
        retry: 'reconcile',
        status: 503,
        outcome: 'unknown',
    });
});

test('truncated streams preserve their partial outcome and never emit completion', async () => {
    const model = new DashScopeChat(
        'key',
        undefined,
        async () =>
            new globalThis.Response(
                'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
                { headers: { 'content-type': 'text/event-stream' } }
            )
    );
    const events = [];
    await assert.rejects(
        async () => {
            for await (const event of model.generate(
                request,
                new globalThis.AbortController().signal
            ))
                events.push(event);
        },
        error => {
            assert.deepEqual(error.failure, {
                category: 'protocol',
                retry: 'never',
                outcome: 'partial',
            });
            return true;
        }
    );
    assert.deepEqual(events, [{ type: 'text', text: 'partial' }]);
});

test('incomplete terminal events preserve provider-reported usage on the failure', async () => {
    const model = new DashScopeChat(
        'key',
        undefined,
        async () =>
            new globalThis.Response(
                'data: {"type":"response.incomplete","response":{"status":"incomplete","usage":{"input_tokens":7,"output_tokens":4096}}}\n\n',
                { headers: { 'content-type': 'text/event-stream' } }
            )
    );
    await assert.rejects(
        async () => {
            for await (const event of model.generate(
                request,
                new globalThis.AbortController().signal
            ))
                assert.fail(event.type);
        },
        error => {
            assert.deepEqual(error.usage, { inputTokens: 7, outputTokens: 4096 });
            return true;
        }
    );
});

test('thinking levels map to native wire values and required thinking rejects off before fetching', async () => {
    const sent = [];
    const transport = async (_url, options) => {
        const body = JSON.parse(options.body);
        sent.push({
            model: body.model,
            reasoning: body.reasoning ?? null,
            enable_thinking: body.enable_thinking ?? null,
        });
        return new globalThis.Response(
            'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
            { headers: { 'content-type': 'text/event-stream' } }
        );
    };
    for (const modelCard of cards) {
        const model = new DashScopeChat('key', undefined, transport, modelCard);
        for await (const event of model.generate(
            { ...request, card: modelCard },
            new globalThis.AbortController().signal
        ))
            assert.deepEqual(event, { type: 'completed', usage: {} });
    }
    assert.deepEqual(sent, [
        { model: 'qwen3.8-max', reasoning: { effort: 'xhigh' }, enable_thinking: null },
        { model: 'qwen3.8-flash', reasoning: { effort: 'xhigh' }, enable_thinking: null },
        { model: 'deepseek-v4.1-flash', reasoning: { effort: 'high' }, enable_thinking: null },
        { model: 'deepseek-v4-pro-0813', reasoning: { effort: 'high' }, enable_thinking: null },
        { model: 'glm-5.3-prime', reasoning: { effort: 'max' }, enable_thinking: null },
        { model: 'kimi-k3', reasoning: null, enable_thinking: true },
    ]);
    for (const modelCard of cards.filter(item => item.thinkingRequired)) {
        const model = new DashScopeChat('key', undefined, transport, modelCard);
        await assert.rejects(async () => {
            for await (const event of model.generate(
                { ...request, card: modelCard, thinkingLevel: 'off' },
                new globalThis.AbortController().signal
            ))
                assert.fail(event.type);
        }, /Unsupported thinking level/);
    }
    assert.equal(sent.length, 6);
});

test('reasoning deltas and continuation items survive streaming and are replayed separately from answer text', async () => {
    const item = {
        type: 'reasoning',
        id: 'r1',
        summary: [{ type: 'summary_text', text: 'Consider the problem.' }],
    };
    let sent;
    const model = new DashScopeChat('key', undefined, async (_url, options) => {
        sent = JSON.parse(options.body);
        return new globalThis.Response(
            [
                { type: 'response.reasoning_text.delta', delta: 'Consider the problem.' },
                { type: 'response.output_item.done', item },
                { type: 'response.output_text.delta', delta: 'Answer.' },
                {
                    type: 'response.completed',
                    response: {
                        status: 'completed',
                        usage: { output_tokens: 9, output_tokens_details: { reasoning_tokens: 5 } },
                    },
                },
            ]
                .map(event => `data: ${JSON.stringify(event)}\n\n`)
                .join(''),
            { headers: { 'content-type': 'text/event-stream' } }
        );
    });
    const events = [];
    for await (const event of model.generate(request, new globalThis.AbortController().signal))
        events.push(event);
    assert.deepEqual(events, [
        { type: 'reasoning', text: 'Consider the problem.' },
        { type: 'continuation', item },
        { type: 'text', text: 'Answer.' },
        { type: 'completed', usage: { outputTokens: 9, reasoningTokens: 5 } },
    ]);
    for await (const event of model.generate(
        {
            ...request,
            messages: [
                ...request.messages,
                {
                    id: 'answer',
                    role: 'assistant',
                    origin: 'assistant',
                    blocks: [
                        { type: 'reasoning', text: 'Consider the problem.' },
                        { type: 'continuation', item },
                        { type: 'text', text: 'Answer.' },
                    ],
                },
            ],
        },
        new globalThis.AbortController().signal
    ))
        assert.ok(event);
    assert.deepEqual(sent.input, [
        { role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
        item,
        { role: 'assistant', content: [{ type: 'output_text', text: 'Answer.' }] },
    ]);
});
