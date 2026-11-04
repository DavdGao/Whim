import { ApplicationError } from '@whimkit/core';
import { continuationSchema, resolveThinking } from '@whimkit/models';
import { z } from 'zod';

import { card } from './cards.js';

import type { Failure } from '@whimkit/core';
import type { ChatAdapter, ChatEvent, ChatRequest, ChatModelCard } from '@whimkit/models';

export { cards, card } from './cards.js';

const eventSchema = z.object({
    type: z.string(),
    delta: z.string().optional(),
    item: z.object({ type: z.string() }).passthrough().optional(),
    response: z
        .object({
            status: z.string(),
            usage: z
                .object({
                    input_tokens: z.number().int().nonnegative().optional(),
                    output_tokens: z.number().int().nonnegative().optional(),
                    total_tokens: z.number().int().nonnegative().optional(),
                    input_tokens_details: z
                        .object({ cached_tokens: z.number().int().nonnegative().optional() })
                        .optional(),
                    output_tokens_details: z
                        .object({ reasoning_tokens: z.number().int().nonnegative().optional() })
                        .optional(),
                })
                .optional(),
        })
        .optional(),
});

/**
 * Map provider evidence into application categories without retaining raw response content.
 * @returns A content-free application failure.
 * @param status
 * @param body
 * @param retryAfter
 */
export function normalizeHttpFailure(
    status: number,
    body: unknown,
    retryAfter: string | null
): Failure {
    const parsed = z
        .object({
            error: z.object({ code: z.string().optional() }).optional(),
            code: z.string().optional(),
        })
        .safeParse(body);
    const code = parsed.success
        ? (parsed.data.error?.code ?? parsed.data.code ?? '').toLowerCase()
        : '';
    let category: Failure['category'] = 'protocol';
    let retry: Failure['retry'] = 'never';
    if (status === 401) {
        category = 'authentication';
        retry = 'after-change';
    } else if (status === 403) {
        category = 'permission';
        retry = 'after-change';
    } else if (/quota|arrearage|insufficient/.test(code)) {
        category = 'quota-exhausted';
        retry = 'after-change';
    } else if (status === 429) {
        category = 'rate-limited';
        retry = 'backoff';
    } else if (status >= 500) {
        category = 'unavailable';
        retry = 'reconcile';
    } else if (/context|length/.test(code)) {
        category = 'context-limit';
        retry = 'after-change';
    } else if (status >= 400) {
        category = 'invalid-input';
        retry = 'after-change';
    }
    const delay =
        retryAfter === null
            ? NaN
            : /^\d+(\.\d+)?$/.test(retryAfter)
              ? Number(retryAfter) * 1000
              : Date.parse(retryAfter) - Date.now();
    return {
        category,
        retry,
        status,
        outcome: status >= 500 ? 'unknown' : 'rejected',
        ...(Number.isFinite(delay) ? { retryAfterMs: Math.max(0, delay) } : {}),
    };
}

/** Stateless Responses adapter with explicit completion and no hidden retries. */
export class DashScopeChat implements ChatAdapter {
    readonly card: ChatModelCard;
    readonly limits = { maxInputTokens: 100000, maxOutputTokens: 8192 };
    /**
     * Bind one credential and endpoint for the lifetime of an adapter generation.
     * @param apiKey
     * @param endpoint
     * @param transport
     * @param modelCard
     * @param resolveImage
     */
    constructor(
        private readonly apiKey: string,
        private readonly endpoint = 'https://dashscope.aliyuncs.com/compatible-mode/v1/responses',
        private readonly transport: typeof fetch = fetch,
        modelCard: ChatModelCard = card,
        private readonly resolveImage?: (id: string, signal: AbortSignal) => Promise<string>
    ) {
        this.card = modelCard;
    }

    /**
     * Conservatively estimate UTF-8 bytes plus message overhead as input tokens.
     * @returns The local admission estimate.
     * @param request
     * @param signal
     */
    async estimateTokens(request: ChatRequest, signal: AbortSignal): Promise<number> {
        signal.throwIfAborted();
        return (
            new TextEncoder().encode(request.system).length +
            request.messages.reduce(
                (sum, message) =>
                    sum +
                    32 +
                    message.blocks.reduce(
                        (size, block) =>
                            size +
                            (block.type === 'image'
                                ? 20000
                                : block.type === 'continuation'
                                  ? new TextEncoder().encode(JSON.stringify(block.item)).length
                                  : new TextEncoder().encode(block.text).length),
                        0
                    ),
                0
            )
        );
    }

    /**
     * Decode bounded SSE frames; EOF, incomplete responses, and protocol errors cannot succeed.
     * @param request
     * @param signal
     */
    async *generate(request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
        const input: unknown[] = [];
        for (const message of request.messages) {
            const content: unknown[] = [];
            for (const block of message.blocks) {
                if (block.type === 'continuation') input.push(block.item);
                if (block.type === 'text' && block.text)
                    content.push({
                        type: message.role === 'assistant' ? 'output_text' : 'input_text',
                        text: block.text,
                    });
                if (block.type === 'image') {
                    if (
                        !this.resolveImage ||
                        message.role !== 'user' ||
                        !this.card.inputMedia[block.artifact.mediaType]
                    )
                        throw new ApplicationError({
                            category: 'invalid-input',
                            retry: 'after-change',
                            outcome: 'rejected',
                        });
                    content.push({
                        type: 'input_image',
                        image_url: await this.resolveImage(block.artifact.id, signal),
                    });
                }
            }
            if (content.length) input.push({ role: message.role, content });
        }
        const thinking = resolveThinking(this.card, request.thinkingLevel);
        if (typeof thinking === 'number')
            throw new ApplicationError({
                category: 'invalid-input',
                retry: 'after-change',
                outcome: 'rejected',
            });
        const body = JSON.stringify({
            model: this.card.modelId,
            instructions: request.system,
            input,
            stream: true,
            store: false,
            ...(typeof thinking === 'string'
                ? { reasoning: { effort: thinking } }
                : typeof thinking === 'boolean'
                  ? { enable_thinking: thinking }
                  : {}),
            max_output_tokens: Math.min(
                this.limits.maxOutputTokens,
                this.card.maxOutputTokens ?? this.limits.maxOutputTokens
            ),
        });
        if (new TextEncoder().encode(body).length > 16000000)
            throw new ApplicationError({
                category: 'invalid-input',
                retry: 'after-change',
                outcome: 'rejected',
            });
        let response: Response;
        try {
            response = await this.transport(this.endpoint, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body,
                signal,
            });
        } catch (cause) {
            throw new ApplicationError(
                {
                    category: signal.aborted ? 'cancelled' : 'transport',
                    retry: signal.aborted ? 'never' : 'reconcile',
                    outcome: 'unknown',
                },
                { cause }
            );
        }
        if (!response.ok) {
            let errorBody: unknown;
            try {
                errorBody = await response.json();
            } catch {
                errorBody = null;
            }
            throw new ApplicationError(
                normalizeHttpFailure(
                    response.status,
                    errorBody,
                    response.headers.get('retry-after')
                )
            );
        }
        if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream'))
            throw new ApplicationError({
                category: 'protocol',
                retry: 'never',
                outcome: 'unknown',
            });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let published = false;
        let failed = false;
        try {
            while (true) {
                const chunk = await reader.read();
                buffer += decoder.decode(chunk.value, { stream: !chunk.done });
                if (buffer.length > 2097152) throw new Error('SSE frame exceeds limit.');
                let boundary: RegExpExecArray | null;
                while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
                    const frame = buffer.slice(0, boundary.index);
                    buffer = buffer.slice(boundary.index + boundary[0].length);
                    const data = frame
                        .split(/\r?\n/)
                        .filter(line => line.startsWith('data:'))
                        .map(line => line.slice(5).trimStart())
                        .join('\n');
                    if (!data || data === '[DONE]') continue;
                    const event = eventSchema.parse(JSON.parse(data));
                    if (
                        event.type === 'response.output_item.done' &&
                        event.item?.type === 'reasoning'
                    ) {
                        yield { type: 'continuation', item: continuationSchema.parse(event.item) };
                    } else if (
                        event.type === 'response.output_text.delta' ||
                        event.type === 'response.reasoning_text.delta'
                    ) {
                        if (event.delta === undefined) throw new Error('Missing text delta.');
                        for (let offset = 0; offset < event.delta.length; offset += 8192) {
                            published = true;
                            yield {
                                type:
                                    event.type === 'response.reasoning_text.delta'
                                        ? 'reasoning'
                                        : 'text',
                                text: event.delta.slice(offset, offset + 8192),
                            };
                        }
                    } else if (event.type === 'response.completed') {
                        if (event.response?.status !== 'completed')
                            throw new Error('Invalid completion status.');
                        yield { type: 'completed', usage: responseUsage(event.response) };
                        return;
                    } else if (
                        ['error', 'response.failed', 'response.incomplete'].includes(event.type)
                    )
                        throw new ApplicationError(
                            {
                                category: 'protocol',
                                retry: 'never',
                                outcome: published ? 'partial' : 'unknown',
                            },
                            undefined,
                            responseUsage(event.response)
                        );
                }
                if (chunk.done) throw new Error('Missing completion event.');
            }
        } catch (cause) {
            failed = true;
            if (cause instanceof ApplicationError) throw cause;
            throw new ApplicationError(
                {
                    category: signal.aborted ? 'cancelled' : 'protocol',
                    retry: 'never',
                    outcome: published ? 'partial' : 'unknown',
                },
                { cause }
            );
        } finally {
            try {
                await reader.cancel();
            } catch (cause) {
                if (!failed)
                    throw new ApplicationError(
                        {
                            category: 'transport',
                            retry: 'never',
                            outcome: published ? 'partial' : 'unknown',
                        },
                        { cause }
                    );
            } finally {
                reader.releaseLock();
            }
        }
    }
}

/**
 * Normalize reported usage without turning missing fields into zero.
 * @returns Only token counts reported by the provider.
 * @param response
 */
function responseUsage(response: z.infer<typeof eventSchema>['response']) {
    const usage = response?.usage;
    return {
        ...(usage?.input_tokens !== undefined ? { inputTokens: usage.input_tokens } : {}),
        ...(usage?.output_tokens !== undefined ? { outputTokens: usage.output_tokens } : {}),
        ...(usage?.total_tokens !== undefined ? { totalTokens: usage.total_tokens } : {}),
        ...(usage?.input_tokens_details?.cached_tokens !== undefined
            ? { cachedInputTokens: usage.input_tokens_details.cached_tokens }
            : {}),
        ...(usage?.output_tokens_details?.reasoning_tokens !== undefined
            ? { reasoningTokens: usage.output_tokens_details.reasoning_tokens }
            : {}),
    };
}
