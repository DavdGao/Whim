import { z } from 'zod';

import { readSse } from './sse.js';

import type { NativeToolCallBlock, ToolDeclaration, Usage } from '@whimkit/core/contracts';
import type { ChatEvent, ChatRequestMessage, InlineMedia } from '@whimkit/core/plugin';

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

export interface InputOptions {
    /**
     * Input items that replay a provider-executed call; by default its stored output item.
     * Return an empty array to drop it.
     */
    readonly replayNative?: (block: NativeToolCallBlock) => unknown[];
}

/**
 * An inline image as a Responses `input_image` with a Base64 data URI.
 * @param media The media; Core passes only types the card accepts.
 * @returns The content part.
 */
function toInputImage(media: InlineMedia): unknown {
    return { type: 'input_image', image_url: `data:${media.mediaType};base64,${media.data}` };
}

/**
 * Serialize messages as Responses `input` items. Continuation and native items are replayed
 * only when they were produced by the same adapter in the current format.
 * @param messages Request messages.
 * @param adapterId The adapter serializing the request.
 * @param options Native replay policy.
 * @returns The `input` array.
 */
export function toResponsesInput(
    messages: readonly ChatRequestMessage[],
    adapterId: string,
    options: InputOptions = {}
): unknown[] {
    const input: unknown[] = [];
    for (const message of messages) {
        if (message.role === 'tool') {
            input.push({
                type: 'function_call_output',
                call_id: message.callId,
                // Media go as a content list only when the adapter declared it carries them.
                output: message.media?.length
                    ? [
                          { type: 'input_text', text: message.content },
                          ...message.media.map(media => toInputImage(media)),
                      ]
                    : message.content,
            });
            continue;
        }
        const content: unknown[] = [];
        const flush = () => {
            if (content.length) input.push({ role: message.role, content: content.splice(0) });
        };
        for (const block of message.blocks) {
            if (block.type === 'inline_media') {
                if (message.role === 'user') content.push(toInputImage(block));
            } else if (block.type === 'text' && block.text.length > 0)
                content.push({
                    type: message.role === 'assistant' ? 'output_text' : 'input_text',
                    text: block.text,
                });
            else if (block.type === 'tool_call') {
                flush();
                input.push({
                    type: 'function_call',
                    call_id: block.callId,
                    name: block.name,
                    arguments: block.arguments,
                });
            } else if (
                (block.type === 'continuation' || block.type === 'native_tool_call') &&
                block.adapter === adapterId &&
                block.format === responsesContinuationFormat
            ) {
                flush();
                if (block.type === 'continuation') input.push(block.data);
                else input.push(...(options.replayNative?.(block) ?? [block.data]));
            }
        }
        flush();
    }
    return input;
}

/**
 * Declare local tools as Responses function tools.
 * @param tools Tool declarations.
 * @returns Entries for the request's `tools` array.
 */
export function toResponsesTools(tools: readonly ToolDeclaration[]): unknown[] {
    return tools.map(tool => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
    }));
}

const functionCallSchema = z.looseObject({
    type: z.literal('function_call'),
    call_id: z.string().min(1),
    name: z.string().min(1),
    arguments: z.string(),
});

const webSearchCallSchema = z.looseObject({
    type: z.literal('web_search_call'),
    status: z.string().optional(),
    action: z
        .looseObject({
            query: z.string().nullish(),
            sources: z.array(z.looseObject({ url: z.string().nullish() })).nullish(),
        })
        .nullish(),
});

/** A provider-executed call as a stream event, minus the parts the caller fills in. */
export type NativeEvent = Extract<ChatEvent, { type: 'native-tool-call' }>;

export interface StreamOptions {
    /** Map vendor-specific output items to native calls; consulted before the defaults. */
    readonly nativeItem?: (item: Readonly<Record<string, unknown>>) => NativeEvent | undefined;
}

/**
 * Interpret a finished output item.
 * @param item The item.
 * @param options Vendor mapping.
 * @returns The event it produces, if any.
 */
function itemEvent(
    item: Readonly<Record<string, unknown>> & { type: string },
    options: StreamOptions
): ChatEvent | undefined {
    if (item.type === 'reasoning')
        return { type: 'continuation', format: responsesContinuationFormat, data: item };
    const call = functionCallSchema.safeParse(item);
    if (call.success)
        return {
            type: 'tool-call',
            callId: call.data.call_id,
            name: call.data.name,
            arguments: call.data.arguments,
        };
    const vendor = options.nativeItem?.(item);
    if (vendor) return vendor;
    const search = webSearchCallSchema.safeParse(item);
    if (search.success) {
        const urls = (search.data.action?.sources ?? []).flatMap(source =>
            source.url ? [source.url] : []
        );
        return {
            type: 'native-tool-call',
            format: responsesContinuationFormat,
            tool: 'web_search',
            status: search.data.status === 'failed' ? 'failed' : 'completed',
            ...(search.data.action?.query ? { query: search.data.action.query } : {}),
            ...(urls.length ? { urls } : {}),
            data: item,
        };
    }
    return undefined;
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
 * @param options Vendor mapping of output items.
 * @yields Normalized events.
 */
export async function* readResponsesStream(
    body: ReadableStream<Uint8Array>,
    options: StreamOptions = {}
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
            case 'response.output_item.done': {
                const produced = event.item ? itemEvent(event.item, options) : undefined;
                if (produced) yield produced;
                break;
            }
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
