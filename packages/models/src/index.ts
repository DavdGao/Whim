import { z } from 'zod';

export const idSchema = z.string().min(1).max(200);
export const mediaTypeSchema = z.string().regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/);
export const supportSchema = z.enum(['supported', 'unsupported', 'unknown']);
export const thinkingLevelSchema = z.enum([
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
]);
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;
const thinkingValueSchema = z.union([z.string(), z.number().int().nonnegative(), z.boolean()]);
const limitSchema = z.number().int().positive().nullable();

export const inputMediaSchema = z.strictObject({
    routes: z
        .array(
            z.strictObject({
                delivery: z.enum(['text', 'structured-value', 'inline-bytes', 'file-id', 'url']),
                maxBytes: limitSchema,
                maxPages: limitSchema.optional(),
                maxEncodedBytes: limitSchema.optional(),
                protocol: z.enum(['responses', 'chat-completions']).optional(),
            })
        )
        .min(1),
});

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
    maxInputTokens: limitSchema.optional(),
    maxInputTokensThinking: limitSchema.optional(),
    maxThinkingTokens: limitSchema.optional(),
    capabilities: z.strictObject({
        streaming: z.boolean(),
        tools: z.boolean(),
        structuredOutput: z.boolean(),
        thinking: z.boolean(),
        webSearch: z.boolean(),
        webFetch: z.boolean(),
    }),
    requestLimits: z.strictObject({
        maxAttachments: limitSchema,
        maxAttachmentBytes: limitSchema,
        maxRequestBytes: limitSchema,
    }),
    thinkingLevelMap: z
        .partialRecord(thinkingLevelSchema, thinkingValueSchema.nullable())
        .optional(),
    defaultThinkingLevel: thinkingLevelSchema.optional(),
    thinkingRequired: z.boolean().optional(),
});

export const continuationSchema = z
    .object({ type: z.literal('reasoning'), id: z.string().optional() })
    .passthrough();
export const attachmentSchema = z.strictObject({
    id: idSchema,
    name: z.string().max(255),
    mediaType: mediaTypeSchema,
    size: z.number().int().positive().max(10000000),
});
export const blockSchema = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('text'), text: z.string() }),
    z.strictObject({ type: z.literal('reasoning'), text: z.string() }),
    z.strictObject({ type: z.literal('continuation'), item: continuationSchema }),
    z.strictObject({ type: z.literal('image'), artifact: attachmentSchema }),
]);
export const entrySchema = z.strictObject({
    id: idSchema,
    role: z.enum(['user', 'assistant']),
    origin: z.enum(['user', 'assistant', 'host']),
    blocks: z.array(blockSchema).min(1),
    attachments: z.array(attachmentSchema).max(4).optional(),
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
    z.strictObject({ type: z.literal('reasoning'), text: z.string().min(1).max(16384) }),
    z.strictObject({ type: z.literal('continuation'), item: continuationSchema }),
    z.strictObject({ type: z.literal('completed'), usage: tokenUsageSchema }),
]);

export type ChatModelCard = z.infer<typeof chatModelCardSchema>;
export type Entry = z.infer<typeof entrySchema>;
export type Block = Entry['blocks'][number];
export type TokenUsage = z.infer<typeof tokenUsageSchema>;
export type ChatEvent = z.infer<typeof chatEventSchema>;

export interface ChatRequest {
    readonly card: ChatModelCard;
    readonly limits?: { maxInputTokens: number; maxOutputTokens: number };
    readonly system: string;
    readonly messages: readonly Entry[];
    readonly purpose: 'chat' | 'compaction';
    readonly thinkingLevel?: ThinkingLevel;
}

export interface ChatAdapter {
    readonly card: ChatModelCard;
    readonly limits?: { maxInputTokens: number; maxOutputTokens: number };
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
        !input?.routes.some(route => route.delivery === 'text') ||
        card.outputMedia['text/plain'] !== 'supported'
    ) {
        throw new Error('The model route must support text input and output.');
    }
    return card;
}

/** Resolve one application level through the model's explicit provider mapping.
 * @param card The frozen model card.
 * @param level The requested application level, or the card default.
 * @returns A provider-native value; undefined when thinking has no configured control.
 */
export function resolveThinking(
    card: ChatModelCard,
    level = card.defaultThinkingLevel
): string | number | boolean | undefined {
    if (level === undefined) return undefined;
    thinkingLevelSchema.parse(level);
    const value = card.thinkingLevelMap?.[level];
    if (value === undefined || value === null || (level === 'off' && card.thinkingRequired))
        throw new Error(`Unsupported thinking level: ${level}`);
    return value;
}
