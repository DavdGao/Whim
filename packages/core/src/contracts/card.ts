import { z } from 'zod';

/** The fixed thinking vocabulary; cards list the subset they support. */
export const thinkingLevels = ['off', 'low', 'medium', 'high', 'max'] as const;
export const thinkingLevelSchema = z.enum(thinkingLevels);
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;

export const mediaTypeSchema = z
    .string()
    .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/, 'Expected a lowercase media type.');
export const idSchema = z.string().min(1).max(200);
const positiveInt = z.number().int().positive();

export const deliverySchema = z.enum(['inline', 'url', 'file']);

export const inputMediaSchema = z.strictObject({
    delivery: z.array(deliverySchema).min(1).optional(),
    maxBytes: positiveInt.optional(),
    maxPages: positiveInt.optional(),
});

export const thinkingSchema = z.union([
    z.strictObject({ fixed: z.literal(true) }),
    z
        .strictObject({
            levels: z.array(thinkingLevelSchema).min(1).max(thinkingLevels.length),
            default: thinkingLevelSchema,
        })
        .refine(value => value.levels.includes(value.default), {
            message: 'The default level must be one of the listed levels.',
            path: ['default'],
        })
        .refine(value => new Set(value.levels).size === value.levels.length, {
            message: 'Levels must be unique.',
            path: ['levels'],
        }),
]);
export type Thinking = z.infer<typeof thinkingSchema>;

/** A Chat model card as published by a plugin or written by the user. */
export const chatCardSchema = z.strictObject({
    $schema: z.string().optional(),
    id: idSchema,
    revision: positiveInt,
    kind: z.literal('chat'),
    adapter: idSchema,
    model: idSchema,
    name: z.string().min(1).max(200),
    contextWindow: positiveInt,
    maxOutputTokens: positiveInt,
    input: z
        .record(mediaTypeSchema, inputMediaSchema)
        .refine(value => 'text/plain' in value, 'Chat cards must accept text/plain input.'),
    output: z.array(mediaTypeSchema).min(1),
    thinking: thinkingSchema.optional(),
    nativeTools: z.array(idSchema).default([]),
    options: z.record(z.string(), z.unknown()).default({}),
});
export type ChatCard = z.infer<typeof chatCardSchema>;

export const cardSchema = z.discriminatedUnion('kind', [chatCardSchema]);
export type Card = z.infer<typeof cardSchema>;

/**
 * The card fields a session froze into its epoch. Decoded leniently so that later card schema
 * changes never make stored sessions unreadable; adapters re-validate `options` when opening.
 */
export const frozenChatCardSchema = z.looseObject({
    id: idSchema,
    revision: positiveInt,
    adapter: idSchema,
    model: idSchema,
    name: z.string(),
    contextWindow: positiveInt,
    maxOutputTokens: positiveInt,
    input: z.record(z.string(), z.looseObject({})),
    output: z.array(z.string()),
    thinking: z.unknown().optional(),
    nativeTools: z.array(z.string()).default([]),
    options: z.record(z.string(), z.unknown()).default({}),
});
export type FrozenChatCard = z.infer<typeof frozenChatCardSchema>;

/**
 * Thinking levels a frozen or live card allows the user to pick; empty when not adjustable.
 * @param thinking The card's `thinking` field.
 * @returns Selectable levels.
 */
export function selectableLevels(thinking: unknown): readonly ThinkingLevel[] {
    const parsed = thinkingSchema.safeParse(thinking);
    if (!parsed.success || 'fixed' in parsed.data) return [];
    return parsed.data.levels;
}
