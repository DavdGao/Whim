import { z } from 'zod';

import { frozenChatCardSchema, idSchema, thinkingLevelSchema } from './card.js';
import { failureSchema } from './failure.js';

export const textBlockSchema = z.strictObject({ type: z.literal('text'), text: z.string() });
export const reasoningBlockSchema = z.strictObject({
    type: z.literal('reasoning'),
    text: z.string(),
    /** Wall time from the first reasoning delta to the first answer delta or the attempt's end. */
    durationMs: z.number().int().nonnegative().optional(),
});
/** Opaque provider state replayed only through the adapter that produced it. */
export const continuationBlockSchema = z.strictObject({
    type: z.literal('continuation'),
    adapter: idSchema,
    format: z.number().int().positive(),
    data: z.unknown(),
});
export const blockSchema = z.discriminatedUnion('type', [
    textBlockSchema,
    reasoningBlockSchema,
    continuationBlockSchema,
]);
export type Block = z.infer<typeof blockSchema>;

export const messageSchema = z.strictObject({
    type: z.literal('message'),
    id: idSchema,
    role: z.enum(['user', 'assistant']),
    blocks: z.array(blockSchema),
});
export type Message = z.infer<typeof messageSchema>;

export const noticeOriginSchema = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('core'), service: z.string().min(1) }),
    z.strictObject({ type: z.literal('plugin'), pluginId: idSchema }),
    z.strictObject({ type: z.literal('user') }),
]);

const noticeBase = {
    type: z.literal('notice'),
    id: idSchema,
    origin: noticeOriginSchema,
    observedAt: z.iso.datetime(),
};

/** Core notice kinds; each kind owns a typed payload. */
export const noticeSchema = z.discriminatedUnion('kind', [
    z.strictObject({
        ...noticeBase,
        kind: z.literal('interrupted'),
        payload: z.strictObject({
            runId: idSchema,
            reason: z.enum(['user', 'plugin-removed']),
        }),
    }),
    z.strictObject({
        ...noticeBase,
        kind: z.literal('restarted'),
        payload: z.strictObject({ runId: idSchema }),
    }),
]);
export type Notice = z.infer<typeof noticeSchema>;

export const contextItemSchema = z.union([messageSchema, noticeSchema]);
export type ContextItem = z.infer<typeof contextItemSchema>;

export const usageSchema = z.strictObject({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    reasoningTokens: z.number().int().nonnegative().optional(),
});
export type Usage = z.infer<typeof usageSchema>;

const assistantOutputSchema = z.strictObject({
    messageId: idSchema,
    blocks: z.array(blockSchema),
});
export type AssistantOutput = z.infer<typeof assistantOutputSchema>;

export const placementSchema = z.enum(['next-step', 'next-run']);
export const interruptReasonSchema = z.enum(['user', 'shutdown', 'crash', 'plugin-removed']);

export const attemptResultSchema = z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('completed'), output: assistantOutputSchema }),
    z.strictObject({ status: z.literal('interrupted'), output: assistantOutputSchema }),
    z.strictObject({ status: z.literal('failed'), failure: failureSchema }),
]);

export const runResultSchema = z.discriminatedUnion('outcome', [
    z.strictObject({ outcome: z.literal('completed') }),
    z.strictObject({ outcome: z.literal('interrupted'), reason: interruptReasonSchema }),
    z.strictObject({ outcome: z.literal('failed'), failure: failureSchema }),
]);

/** Every fact the journal can hold. Bodies are versioned through the record envelope. */
export const bodySchema = z.discriminatedUnion('type', [
    z.strictObject({
        type: z.literal('session.created'),
        title: z.string().max(200),
        credentialId: idSchema,
        thinking: thinkingLevelSchema.optional(),
    }),
    z.strictObject({
        type: z.literal('session.updated'),
        title: z.string().max(200).optional(),
        credentialId: idSchema.optional(),
        thinking: thinkingLevelSchema.nullable().optional(),
    }),
    z.strictObject({
        type: z.literal('epoch.started'),
        epochId: idSchema,
        reason: z.enum(['initial', 'model-switch', 'compaction']),
        system: z.string(),
        card: frozenChatCardSchema,
        renderer: z.number().int().positive(),
    }),
    z.strictObject({
        type: z.literal('delivery.accepted'),
        deliveryId: idSchema,
        placement: placementSchema,
        item: contextItemSchema,
    }),
    z.strictObject({ type: z.literal('delivery.withdrawn'), deliveryId: idSchema }),
    z.strictObject({
        type: z.literal('run.started'),
        runId: idSchema,
        trigger: z.enum(['user', 'continue', 'restart']),
    }),
    z.strictObject({
        type: z.literal('step.prepared'),
        runId: idSchema,
        stepId: idSchema,
        consumed: z.array(idSchema),
    }),
    z.strictObject({
        type: z.literal('attempt.started'),
        runId: idSchema,
        stepId: idSchema,
        attemptId: idSchema,
        number: z.number().int().positive(),
    }),
    z.strictObject({
        type: z.literal('attempt.finished'),
        attemptId: idSchema,
        usage: usageSchema,
        result: attemptResultSchema,
    }),
    z.strictObject({
        type: z.literal('retry.scheduled'),
        runId: idSchema,
        stepId: idSchema,
        number: z.number().int().positive(),
        at: z.iso.datetime(),
        failure: failureSchema,
    }),
    z.strictObject({
        type: z.literal('interrupt.requested'),
        runId: idSchema,
        reason: interruptReasonSchema,
    }),
    z.strictObject({
        type: z.literal('run.ended'),
        runId: idSchema,
        result: runResultSchema,
    }),
]);
export type Body = z.infer<typeof bodySchema>;
export type BodyOf<T extends Body['type']> = Extract<Body, { type: T }>;

export const recordSchema = z.strictObject({
    id: idSchema,
    sessionId: idSchema,
    seq: z.number().int().positive(),
    version: z.literal(1),
    createdAt: z.iso.datetime(),
    operationId: idSchema,
    body: bodySchema,
});
export type AgentRecord = z.infer<typeof recordSchema>;
