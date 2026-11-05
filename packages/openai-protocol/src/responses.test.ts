import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readResponsesStream, ResponsesStreamError, toResponsesInput } from './responses.js';
import { readSse } from './sse.js';

/**
 * Build a byte stream from string chunks.
 * @param chunks Text chunks delivered in order.
 * @returns A readable stream.
 */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
        },
    });
}

/**
 * Collect an async iterable.
 * @param iterable The source.
 * @returns All items.
 */
async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
    const items: T[] = [];
    for await (const item of iterable) items.push(item);
    return items;
}

describe('readSse', () => {
    it('handles CRLF split across chunks, comments, and multi-line data', async () => {
        const events = await collect(
            readSse(
                streamOf([': hi\r', '\nevent: a\r\ndata: 1\r', '\ndata: 2\r\n\r\n', 'data: tail'])
            )
        );
        assert.deepEqual(events, [{ event: 'a', data: '1\n2' }]);
    });
});

describe('readResponsesStream', () => {
    const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

    it('yields deltas and completion with usage', async () => {
        const events = await collect(
            readResponsesStream(
                streamOf([
                    frame({ type: 'response.created' }),
                    frame({ type: 'response.reasoning_text.delta', delta: 'think' }),
                    frame({ type: 'response.output_text.delta', delta: 'Hel' }),
                    frame({ type: 'response.output_text.delta', delta: 'lo' }),
                    frame({
                        type: 'response.completed',
                        response: {
                            status: 'completed',
                            usage: {
                                input_tokens: 3,
                                output_tokens: 2,
                                output_tokens_details: { reasoning_tokens: 1 },
                            },
                        },
                    }),
                ])
            )
        );
        assert.deepEqual(events, [
            { type: 'reasoning-delta', text: 'think' },
            { type: 'text-delta', text: 'Hel' },
            { type: 'text-delta', text: 'lo' },
            { type: 'completed', usage: { inputTokens: 3, outputTokens: 2, reasoningTokens: 1 } },
        ]);
    });

    it('treats EOF without completion and in-stream failures as errors', async () => {
        await assert.rejects(
            collect(
                readResponsesStream(
                    streamOf([frame({ type: 'response.output_text.delta', delta: 'x' })])
                )
            ),
            (error: unknown) => error instanceof ResponsesStreamError && error.kind === 'eof'
        );
        await assert.rejects(
            collect(
                readResponsesStream(
                    streamOf([
                        frame({
                            type: 'response.failed',
                            response: { error: { code: 'server_error', message: 'boom' } },
                        }),
                    ])
                )
            ),
            (error: unknown) =>
                error instanceof ResponsesStreamError &&
                error.code === 'server_error' &&
                error.message === 'boom'
        );
    });
});

describe('toResponsesInput', () => {
    it('sends inline images as data URIs, in user messages and tool results', () => {
        const image = { type: 'inline_media', mediaType: 'image/png', data: 'AQID' } as const;
        assert.deepEqual(
            toResponsesInput(
                [
                    { role: 'user', blocks: [{ type: 'text', text: 'look' }, image] },
                    {
                        role: 'tool',
                        callId: 'c',
                        status: 'success',
                        content: 'shot',
                        media: [image],
                    },
                ],
                'a'
            ),
            [
                {
                    role: 'user',
                    content: [
                        { type: 'input_text', text: 'look' },
                        { type: 'input_image', image_url: 'data:image/png;base64,AQID' },
                    ],
                },
                {
                    type: 'function_call_output',
                    call_id: 'c',
                    output: [
                        { type: 'input_text', text: 'shot' },
                        { type: 'input_image', image_url: 'data:image/png;base64,AQID' },
                    ],
                },
            ]
        );
    });

    it('maps roles and replays only matching continuations', () => {
        assert.deepEqual(
            toResponsesInput(
                [
                    { role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
                    {
                        role: 'assistant',
                        blocks: [
                            {
                                type: 'continuation',
                                adapter: 'a#chat',
                                format: 1,
                                data: { type: 'reasoning', id: 'r1' },
                            },
                            {
                                type: 'continuation',
                                adapter: 'other#chat',
                                format: 1,
                                data: { type: 'reasoning', id: 'r2' },
                            },
                            { type: 'reasoning', text: 'hidden' },
                            { type: 'text', text: 'hello' },
                        ],
                    },
                ],
                'a#chat'
            ),
            [
                { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
                { type: 'reasoning', id: 'r1' },
                { role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
            ]
        );
    });
});
