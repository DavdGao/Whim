import { failureSchema, transcriptSchema, uploadSchema } from '@whimkit/core';
import { chatModelCardSchema, thinkingLevelSchema } from '@whimkit/models';
import { z } from 'zod';

export const commandSchema = z.discriminatedUnion('type', [
    z.strictObject({
        type: z.literal('snapshot'),
        sessionId: z.string().optional(),
        refresh: z.boolean().optional(),
    }),
    z.strictObject({ type: z.literal('history'), sessionId: z.string(), beforeId: z.string() }),
    z.strictObject({
        type: z.literal('create'),
        modelId: z.string().optional(),
        thinkingLevel: thinkingLevelSchema.optional(),
    }),
    z.strictObject({
        type: z.literal('send'),
        sessionId: z.string(),
        operationId: z.string().uuid(),
        text: z.string().trim().max(20000),
        files: z.array(uploadSchema).max(4).optional(),
    }),
    z.strictObject({ type: z.literal('stop'), sessionId: z.string() }),
    z.strictObject({ type: z.literal('locale'), locale: z.enum(['en', 'zh-CN']) }),
    z.strictObject({ type: z.literal('credential'), key: z.string().trim().min(1).max(512) }),
]);
export const snapshotSchema = z.object({
    sessions: z.array(z.object({ id: z.string(), createdAt: z.string() })),
    models: z.array(chatModelCardSchema),
    page: transcriptSchema.optional(),
    locale: z.enum(['en', 'zh-CN']),
    configured: z.boolean(),
    active: z.array(z.string()),
    selectedId: z.string().optional(),
});
export const replySchema = z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), snapshot: snapshotSchema }),
    z.object({ ok: z.literal(false), failure: failureSchema }),
]);
export type Command = z.infer<typeof commandSchema>;
export type Reply = z.infer<typeof replySchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export interface DesktopClient {
    invoke(command: Command): Promise<Reply>;
    subscribe(listener: () => void): () => void;
}
