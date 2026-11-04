import { idSchema } from '@whimkit/models';
import { z } from 'zod';

import { commandSchema, recordSchema } from './records.js';

export const requestSchema = z.discriminatedUnion('type', [
    z.strictObject({ id: idSchema, type: z.literal('execute'), command: commandSchema }),
    z.strictObject({ id: idSchema, type: z.literal('read'), sessionId: idSchema }),
    z.strictObject({ id: idSchema, type: z.literal('close') }),
]);
export const responseSchema = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('ready') }),
    z.strictObject({ type: z.literal('result'), id: idSchema, records: z.array(recordSchema) }),
    z.strictObject({
        type: z.literal('error'),
        id: idSchema,
        code: z.enum(['conflict', 'stale-run', 'not-found', 'invalid']),
        message: z.string(),
    }),
]);
export type WorkerRequest = z.infer<typeof requestSchema>;
