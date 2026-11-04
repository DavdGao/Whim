import { z } from 'zod';

import { readSse } from './sse.js';

import type { Usage } from '@whimkit/core/contracts';
import type { ChatEvent, ChatRequestMessage } from '@whimkit/core/plugin';

/** Continuation format version for Responses output items replayed with `store: false`. */
export const responsesContinuationFormat = 1;

const usageSchema = z
    .looseObject({
        input_tokens: z.number().int().nonnegative().optional(),
        output_tokens: z.number().int().nonnegative().optional(),
        total_tokens: z.number().int().nonnegative().optional(),
        input_tokens_details: z
            .looseObject({ cached_tokens: z.number().int().nonnegative().optional() })
            .nullish(),
        output_tokens_details: z
            .looseObject({ reasoning_tokens: z.number().int().nonnegative().optional() })
            .nullish(),
    })
    .nullish();

const errorSchema = z
    .looseObject({ code: z.string().nullish(), message: z.string().nullish() })
    .nullish();

export const streamEventSchema = z.looseObject({
    type: z.string(),
    delta: z.string().optional(),
    item: z.looseObject({ type: z.string() }).optional(),
    response: z
        .looseObject({
            status: z.string().optional(),
            usage: usageSchema,
            error: errorSchema,
            incomplete_details: z.looseObject({ reason: z.string().nullish() }).nullish(),
        })
        .optional(),
    code: z.string().nullish(),
    message: z.string().nullish(),
});
export type StreamEvent = z.infer<typeof streamEventSchema>;

/**
 * Convert reported usage, leaving absent fields unknown.
 * @param usage The provider usage object.
 * @returns Normalized usage.
 */
export function normalizeUsage(usage: z.infer<typeof usageSchema>): Usage {
    if (!usage) return {};
    return {
        ...(usage.input_tokens !== undefined ? { inputTokens: usage.input_tokens } : {}),
        ...(usage.output_tokens !== undefined ? { outputTokens: usage.output_tokens } : {}),
        ...(usage.total_tokens !== undefined ? { totalTokens: usage.total_tokens } : {}),
        ...(usage.input_tokens_details?.cached_tokens !== undefined
            ? { cachedInputTokens: usage.input_tokens_details.cached_tokens }
            : {}),
        ...(usage.output_tokens_details?.reasoning_tokens !== undefined
            ? { reasoningTokens: usage.output_tokens_details.reasoning_tokens }
            : {}),
    };
}

/**
 * Serialize messages as Responses `input` items. Continuation items are replayed only when
 * they were produced by the same adapter in the current format.
 * @param messages Request messages.
 * @param adapterId The adapter serializing the request.
 * @returns The `input` array.
 */
export function toResponsesInput(
    messages: readonly ChatRequestMessage[],
    adapterId: string
): unknown[] {
    const input: unknown[] = [];
    for (const message of messages) {
        const content: unknown[] = [];
        for (const block of message.blocks) {
            if (block.type === 'text' && block.text.length > 0)
                content.push({
                    type: message.role === 'assistant' ? 'output_text' : 'input_text',
                    text: block.text,
                });
            else if (
                block.type === 'continuation' &&
                block.adapter === adapterId &&
                block.format === responsesContinuationFormat
            ) {
                if (content.length) input.push({ role: message.role, content: content.splice(0) });
                input.push(block.data);
            }
        }
        if (content.length) input.push({ role: message.role, content });
    }
    return input;
}

/** A terminal stream failure reported by the provider inside the event stream. */
export class ResponsesStreamError extends Error {
    /**
     * Describe an in-stream failure.
     * @param kind Which terminal event ended the stream.
     * @param usage Usage reported with the failure.
     * @param code Provider error code.
     * @param providerMessage Provider error message.
     */
    constructor(
        readonly kind: 'failed' | 'incomplete' | 'error' | 'eof',
        readonly usage: Usage,
        readonly code?: string,
        readonly providerMessage?: string
    ) {
        super(providerMessage ?? `Response stream ended: ${kind}.`);
        this.name = 'ResponsesStreamError';
    }
}

/**
 * Decode a Responses SSE body into normalized chat events. Ends with `completed` or throws
 * `ResponsesStreamError`; JSON and framing errors propagate unchanged for the adapter to map.
 * @param body The response body.
 * @yields Normalized events.
 */
export async function* readResponsesStream(
    body: ReadableStream<Uint8Array>
): AsyncGenerator<ChatEvent> {
    for await (const frame of readSse(body)) {
        if (frame.data === '[DONE]') continue;
        const event = streamEventSchema.parse(JSON.parse(frame.data));
        switch (event.type) {
            case 'response.output_text.delta':
                if (event.delta) yield { type: 'text-delta', text: event.delta };
                break;
            case 'response.reasoning_text.delta':
            case 'response.reasoning_summary_text.delta':
                if (event.delta) yield { type: 'reasoning-delta', text: event.delta };
                break;
            case 'response.output_item.done':
                if (event.item?.type === 'reasoning')
                    yield {
                        type: 'continuation',
                        format: responsesContinuationFormat,
                        data: event.item,
                    };
                break;
            case 'response.completed':
                yield { type: 'completed', usage: normalizeUsage(event.response?.usage) };
                return;
            case 'response.failed':
                throw new ResponsesStreamError(
                    'failed',
                    normalizeUsage(event.response?.usage),
                    event.response?.error?.code ?? undefined,
                    event.response?.error?.message ?? undefined
                );
            case 'response.incomplete':
                throw new ResponsesStreamError(
                    'incomplete',
                    normalizeUsage(event.response?.usage),
                    event.response?.incomplete_details?.reason ?? undefined
                );
            case 'error':
                throw new ResponsesStreamError(
                    'error',
                    {},
                    event.code ?? undefined,
                    event.message ?? undefined
                );
        }
    }
    throw new ResponsesStreamError('eof', {});
}
