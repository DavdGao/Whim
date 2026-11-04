import { z } from 'zod';

export const idSchema = z.string().min(1).max(200);
export const mediaTypeSchema = z.string().regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/);
export const supportSchema = z.enum(['supported', 'unsupported', 'unknown']);
const limitSchema = z.number().int().positive().nullable();

export const inputMediaSchema = z.discriminatedUnion('support', [
    z.strictObject({
        support: z.literal('supported'),
        routes: z
            .array(
                z.strictObject({
                    delivery: z.enum([
                        'text',
                        'structured-value',
                        'inline-bytes',
                        'file-id',
                        'url',
                    ]),
                    maxBytes: limitSchema,
                    maxPages: limitSchema.optional(),
                })
            )
            .min(1),
    }),
    z.strictObject({ support: z.enum(['unsupported', 'unknown']) }),
]);

export const chatModelCardSchema = z.strictObject({
    kind: z.literal('chat'),
    id: idSchema,
    revision: z.number().int().positive(),
    provider: idSchema,
    adapterId: idSchema,
    modelId: idSchema,
    label: z.string().min(1),
    inputMedia: z.record(mediaTypeSchema, inputMediaSchema),
    outputMedia: z.record(mediaTypeSchema, supportSchema),
    contextTokens: limitSchema,
    maxOutputTokens: limitSchema,
    capabilities: z.strictObject({
        streaming: supportSchema,
        tools: supportSchema,
        structuredOutput: supportSchema,
        thinking: supportSchema,
        webSearch: supportSchema,
        webFetch: supportSchema,
    }),
    requestLimits: z.strictObject({
        maxAttachments: limitSchema,
        maxAttachmentBytes: limitSchema,
        maxRequestBytes: limitSchema,
    }),
    evidence: z.strictObject({ source: z.string().min(1), checkedAt: z.iso.datetime() }),
});

export const entrySchema = z.strictObject({
    id: idSchema,
    role: z.enum(['user', 'assistant']),
    origin: z.enum(['user', 'assistant', 'host']),
    blocks: z.array(z.strictObject({ type: z.literal('text'), text: z.string() })).min(1),
});

export const tokenUsageSchema = z.strictObject({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    reasoningTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
});

export const chatEventSchema = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('text'), text: z.string().min(1).max(16384) }),
    z.strictObject({ type: z.literal('completed'), usage: tokenUsageSchema }),
]);

export type ChatModelCard = z.infer<typeof chatModelCardSchema>;
export type Entry = z.infer<typeof entrySchema>;
export type Block = Entry['blocks'][number];
export type TokenUsage = z.infer<typeof tokenUsageSchema>;
export type ChatEvent = z.infer<typeof chatEventSchema>;

export interface ChatRequest {
    readonly card: ChatModelCard;
    readonly system: string;
    readonly messages: readonly Entry[];
    readonly purpose: 'chat' | 'compaction';
}

export interface ChatAdapter {
    readonly card: ChatModelCard;
    generate(request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;
    estimateTokens(request: ChatRequest, signal: AbortSignal): Promise<number>;
}

/**
 * Reject routes that cannot carry the initial runtime's text-only conversation.
 * @param value Untrusted input to validate or encode.
 * @returns The validated model card.
 */
export function validateTextCard(value: unknown): ChatModelCard {
    const card = chatModelCardSchema.parse(value);
    const input = card.inputMedia['text/plain'];
    if (
        input?.support !== 'supported' ||
        !input.routes.some(route => route.delivery === 'text') ||
        card.outputMedia['text/plain'] !== 'supported'
    ) {
        throw new Error('The model route must support text input and output.');
    }
    return card;
}
