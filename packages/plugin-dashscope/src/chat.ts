import { ApplicationError } from '@whimkit/core/contracts';
import {
    readResponsesStream,
    responsesContinuationFormat,
    ResponsesStreamError,
    toResponsesInput,
    toResponsesTools,
} from '@whimkit/openai-protocol';
import { z } from 'zod';

import { httpFailure, streamFailure } from './errors.js';

import type { FrozenChatCard, NativeToolCallBlock, ThinkingLevel } from '@whimkit/core/contracts';
import type {
    ChatAdapter,
    ChatEvent,
    ChatRequest,
    ChatSession,
    ResolvedCredential,
} from '@whimkit/core/plugin';
import type { NativeEvent } from '@whimkit/openai-protocol';

export const pluginId = '@whimkit/plugin-dashscope';
export const credentialTypeId = `${pluginId}#api-key`;
export const adapterId = `${pluginId}#responses`;
export const defaultBaseUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
/** Default mapping of Whim's levels onto DashScope `reasoning.effort`. */
const defaultEffort: Record<ThinkingLevel, (typeof efforts)[number]> = {
    off: 'none',
    low: 'low',
    medium: 'medium',
    high: 'high',
    max: 'max',
};

export const credentialSchema = {
    type: 'object',
    title: 'DashScope API key',
    required: ['apiKey'],
    additionalProperties: false,
    properties: {
        apiKey: {
            type: 'string',
            title: 'API key',
            writeOnly: true,
            format: 'password',
            minLength: 1,
            'x-whim-order': 1,
        },
        baseUrl: {
            type: 'string',
            title: 'Base URL',
            format: 'uri',
            description: `Full compatible-mode base URL. Leave empty for ${defaultBaseUrl}.`,
            'x-whim-order': 2,
        },
    },
} as const;

const optionsSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        effort: {
            type: 'object',
            description: 'Override the reasoning.effort sent for each thinking level.',
            propertyNames: { enum: ['off', 'low', 'medium', 'high', 'max'] },
            additionalProperties: { enum: [...efforts] },
        },
    },
} as const;

/** Standard native tool ids this adapter implements, and the DashScope tool each maps to. */
const nativeToolTypes: Readonly<Record<string, string>> = {
    web_search: 'web_search',
    web_fetch: 'web_extractor',
};

const extractorCallSchema = z.looseObject({
    type: z.literal('web_extractor_call'),
    status: z.string().optional(),
    goal: z.string().nullish(),
    urls: z.array(z.string()).nullish(),
    output: z.string().nullish(),
});

/**
 * Map DashScope's `web_extractor_call` items, which OpenAI does not define, to `web_fetch`.
 * @param item An output item.
 * @returns The native call, or undefined for other items.
 */
function extractorItem(item: Readonly<Record<string, unknown>>): NativeEvent | undefined {
    const parsed = extractorCallSchema.safeParse(item);
    if (!parsed.success) return undefined;
    return {
        type: 'native-tool-call',
        format: responsesContinuationFormat,
        tool: 'web_fetch',
        status: parsed.data.status === 'failed' ? 'failed' : 'completed',
        ...(parsed.data.goal ? { query: parsed.data.goal } : {}),
        ...(parsed.data.urls?.length ? { urls: parsed.data.urls } : {}),
        data: item,
    };
}

/**
 * Replay a provider-executed call. `web_search_call` items are documented as valid input;
 * extractor calls have no input form, so their summary is replayed as assistant text.
 * @param block The native call.
 * @returns Input items.
 */
function replayNative(block: NativeToolCallBlock): unknown[] {
    if (block.tool !== 'web_fetch') return [block.data];
    const summary = extractorCallSchema.safeParse(block.data).data?.output;
    return summary
        ? [
              {
                  role: 'assistant',
                  content: [
                      {
                          type: 'output_text',
                          text: `Fetched ${(block.urls ?? []).join(', ')}:\n${summary}`,
                      },
                  ],
              },
          ]
        : [];
}

const credentialValues = z.object({ apiKey: z.string().min(1), baseUrl: z.string().optional() });
const cardOptions = z.object({
    effort: z
        .partialRecord(z.enum(['off', 'low', 'medium', 'high', 'max']), z.enum(efforts))
        .optional(),
});

/**
 * Raise a cancellation failure when the caller aborted.
 * @param signal The attempt signal.
 * @param published Whether output was already streamed.
 * @param cause The underlying error.
 */
function throwIfCancelled(signal: AbortSignal, published: boolean, cause: unknown): void {
    if (signal.aborted)
        throw new ApplicationError(
            {
                category: 'cancelled',
                retry: { kind: 'never' },
                outcome: published ? 'partial' : 'unknown',
            },
            { cause }
        );
}

/** One DashScope binding: card, endpoint, and key. */
class DashScopeSession implements ChatSession {
    readonly #endpoint: string;
    readonly #apiKey: string;
    readonly #effort: Partial<Record<ThinkingLevel, (typeof efforts)[number]>>;

    /**
     * Bind a card and credential.
     * @param card The frozen card.
     * @param credential The resolved credential.
     * @param transport The fetch implementation.
     */
    constructor(
        private readonly card: FrozenChatCard,
        credential: ResolvedCredential,
        private readonly transport: typeof fetch
    ) {
        const values = credentialValues.parse(credential.values);
        this.#apiKey = values.apiKey;
        this.#endpoint = `${(values.baseUrl || defaultBaseUrl).replace(/\/+$/, '')}/responses`;
        this.#effort = cardOptions.parse(card.options).effort ?? {};
    }

    /**
     * DashScope silently truncates input above about 80% of the context window, so the budget
     * stays below that point.
     * @returns Input token budget.
     */
    inputBudget(): number {
        return Math.floor(this.card.contextWindow * 0.75);
    }

    /**
     * Stream one Responses call.
     * @param request The chat request.
     * @param signal Cancellation for this attempt.
     * @yields Normalized chat events.
     */
    async *stream(request: ChatRequest, signal: AbortSignal): AsyncGenerator<ChatEvent> {
        const thinking = this.card.thinking;
        const adjustable =
            thinking !== undefined &&
            typeof thinking === 'object' &&
            thinking !== null &&
            'levels' in thinking;
        const effort =
            adjustable && request.thinking
                ? (this.#effort[request.thinking] ?? defaultEffort[request.thinking])
                : undefined;
        const body = JSON.stringify({
            model: this.card.model,
            instructions: request.system,
            input: toResponsesInput(request.messages, adapterId, { replayNative }),
            ...(request.tools.length || request.nativeTools.length
                ? {
                      tools: [
                          ...request.nativeTools.flatMap(id =>
                              nativeToolTypes[id] ? [{ type: nativeToolTypes[id] }] : []
                          ),
                          ...toResponsesTools(request.tools),
                      ],
                  }
                : {}),
            stream: true,
            store: false,
            max_output_tokens: this.card.maxOutputTokens,
            ...(effort ? { reasoning: { effort } } : {}),
        });
        let response: Response;
        try {
            response = await this.transport(this.#endpoint, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.#apiKey}`,
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream',
                },
                body,
                signal,
            });
        } catch (cause) {
            throwIfCancelled(signal, false, cause);
            throw new ApplicationError(
                {
                    category: 'transport',
                    retry: { kind: 'backoff' },
                    outcome: 'unknown',
                    detail: {
                        provider: 'dashscope',
                        message: cause instanceof Error ? cause.message : String(cause),
                    },
                },
                { cause }
            );
        }
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            let parsed: unknown = null;
            try {
                parsed = JSON.parse(text);
            } catch {
                parsed = { message: text.slice(0, 500) };
            }
            throw new ApplicationError(
                httpFailure(response.status, parsed, response.headers.get('retry-after'))
            );
        }
        if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream'))
            throw new ApplicationError({
                category: 'protocol',
                retry: { kind: 'never' },
                outcome: 'unknown',
                detail: {
                    provider: 'dashscope',
                    status: response.status,
                    message: 'Expected an event stream.',
                },
            });
        let published = false;
        try {
            for await (const event of readResponsesStream(response.body, {
                nativeItem: extractorItem,
            })) {
                // Reasoning replay with store:false is unverified for DashScope; do not persist it.
                if (event.type === 'continuation') continue;
                if (event.type !== 'completed') published = true;
                yield event;
            }
        } catch (cause) {
            throwIfCancelled(signal, published, cause);
            if (cause instanceof ApplicationError) throw cause;
            if (cause instanceof ResponsesStreamError)
                throw new ApplicationError(
                    streamFailure(cause.kind, published, cause.code, cause.providerMessage),
                    { cause }
                );
            throw new ApplicationError(
                {
                    category: 'transport',
                    retry: { kind: 'backoff' },
                    outcome: published ? 'partial' : 'unknown',
                    detail: {
                        provider: 'dashscope',
                        message: cause instanceof Error ? cause.message : String(cause),
                    },
                },
                { cause }
            );
        }
    }
}

/**
 * Create the Responses adapter.
 * @param transport The fetch implementation; injectable for tests.
 * @returns The adapter.
 */
export function createChatAdapter(transport: typeof fetch = fetch): ChatAdapter {
    return {
        id: adapterId,
        kind: 'chat',
        credentialTypes: [credentialTypeId],
        optionsSchema,
        validateCard(card) {
            const issues = [];
            for (const tool of card.nativeTools)
                if (!(tool in nativeToolTypes))
                    issues.push({
                        path: 'nativeTools',
                        message: `Native tool ${tool} is not supported by this adapter.`,
                    });
            if (card.nativeTools.includes('web_fetch') && !card.nativeTools.includes('web_search'))
                issues.push({
                    path: 'nativeTools',
                    message: 'DashScope web_fetch (web_extractor) requires web_search.',
                });
            for (const type of Object.keys(card.input))
                if (type !== 'text/plain')
                    issues.push({
                        path: `input.${type}`,
                        message: 'Only text input is implemented yet.',
                    });
            return issues;
        },
        open: ({ card, credential }) => new DashScopeSession(card, credential, transport),
    };
}
