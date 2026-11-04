import { idSchema } from '@whimkit/models';
import { z } from 'zod';

import { artifactSchema, transcriptSchema } from './presentation.js';
import { commandSchema, recordSchema } from './records.js';

export const localeSchema = z.enum(['en', 'zh-CN']);

export const requestSchema = z.discriminatedUnion('type', [
    z.strictObject({ id: idSchema, type: z.literal('execute'), command: commandSchema }),
    z.strictObject({
        id: idSchema,
        type: z.literal('read'),
        sessionId: idSchema,
        afterSeq: z
            .string()
            .regex(/^(0|[1-9][0-9]*)$/)
            .optional(),
    }),
    z.strictObject({ id: idSchema, type: z.literal('close') }),
    z.strictObject({
        id: idSchema,
        type: z.literal('transcript'),
        sessionId: idSchema,
        beforeId: z.string().optional(),
    }),
    z.strictObject({ id: idSchema, type: z.literal('artifact.put'), artifact: artifactSchema }),
    z.strictObject({ id: idSchema, type: z.literal('artifact.get'), artifactId: z.string() }),
    z.strictObject({
        id: idSchema,
        type: z.literal('application'),
        locale: localeSchema.optional(),
    }),
]);
export const responseSchema = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('ready') }),
    z.strictObject({
        type: z.literal('result'),
        id: idSchema,
        records: z.array(recordSchema),
        locale: localeSchema.optional(),
        transcript: transcriptSchema.optional(),
        artifact: artifactSchema.optional(),
    }),
    z.strictObject({
        type: z.literal('error'),
        id: idSchema,
        code: z.enum(['conflict', 'stale-run', 'not-found', 'invalid']),
        message: z.string(),
    }),
]);
export type WorkerRequest = z.infer<typeof requestSchema>;
