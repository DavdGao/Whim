import {
    chatModelCardSchema,
    entrySchema,
    idSchema,
    tokenUsageSchema,
    thinkingLevelSchema,
} from '@whimkit/models';
import { z } from 'zod';

import { failureSchema } from './errors.js';

export const epochSchema = z.strictObject({
    id: idSchema,
    system: z.string().max(262144),
    card: chatModelCardSchema,
    thinkingLevel: thinkingLevelSchema.optional(),
});

export const taskSchema = z.strictObject({
    id: idSchema,
    title: z.string().min(1).max(4096),
    status: z.enum(['pending', 'in_progress', 'completed', 'removed']),
});

export const deliverySchema = z.strictObject({
    id: idSchema,
    entry: entrySchema,
    source: z.enum(['user', 'source-change', 'runtime', 'job', 'middleware', 'agent']),
    placement: z.enum(['next-reasoning', 'next-run']),
});

export const factSchema = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('session.created'), epoch: epochSchema }),
    z.strictObject({ type: z.literal('inbox.accepted'), delivery: deliverySchema }),
    z.strictObject({ type: z.literal('run.started'), runId: idSchema, generation: idSchema }),
    z.strictObject({
        type: z.literal('reasoning.prepared'),
        planId: idSchema,
        runId: idSchema,
        deliveryIds: z.array(idSchema),
        estimatedTokens: z.number().int().nonnegative(),
    }),
    z.strictObject({
        type: z.literal('attempt.started'),
        attemptId: idSchema,
        planId: idSchema,
        messageId: idSchema,
        purpose: z.enum(['chat', 'compaction']),
    }),
    z.strictObject({
        type: z.literal('output.chunk'),
        attemptId: idSchema,
        index: z.number().int().nonnegative(),
        text: z.string().min(1).max(1048576),
        channel: z.enum(['text', 'reasoning', 'continuation']).optional(),
    }),
    z.strictObject({
        type: z.literal('attempt.finished'),
        attemptId: idSchema,
        outcome: z.enum(['completed', 'interrupted', 'failed']),
        reason: z.enum(['user', 'aborted', 'crash', 'model-error', 'consumer-closed']).nullable(),
        usage: tokenUsageSchema,
        failure: failureSchema.optional(),
    }),
    z.strictObject({
        type: z.literal('run.ended'),
        runId: idSchema,
        outcome: z.enum(['completed', 'interrupted', 'failed']),
        failure: failureSchema.optional(),
    }),
    z.strictObject({
        type: z.literal('run.interrupted'),
        runId: idSchema,
        reason: z.enum(['user', 'aborted', 'crash', 'consumer-closed']),
    }),
    z.strictObject({ type: z.literal('session.resumed') }),
    z.strictObject({ type: z.literal('task.updated'), task: taskSchema }),
    z.strictObject({
        type: z.literal('compaction.started'),
        compactionId: idSchema,
        epoch: epochSchema,
        retainedIds: z.array(idSchema),
    }),
    z.strictObject({
        type: z.literal('compaction.finished'),
        compactionId: idSchema,
        attemptId: idSchema,
    }),
]);

export const recordSchema = z.strictObject({
    id: idSchema,
    sessionId: idSchema,
    seq: z.string().regex(/^[1-9][0-9]*$/),
    schemaVersion: z.literal(1),
    operationId: idSchema,
    createdAt: z.iso.datetime(),
    fact: factSchema,
});

const control = { sessionId: idSchema, operationId: idSchema };
const ownership = { runId: idSchema, generation: idSchema };

export const commandSchema = z.discriminatedUnion('type', [
    z.strictObject({ ...control, type: z.literal('create'), epoch: epochSchema }),
    z.strictObject({ ...control, type: z.literal('enqueue'), delivery: deliverySchema }),
    z.strictObject({ ...control, ...ownership, type: z.literal('start') }),
    z.strictObject({
        ...control,
        ...ownership,
        type: z.literal('prepare'),
        planId: idSchema,
        expectedContextVersion: z.string(),
        deliveryIds: z.array(idSchema).max(64),
        estimatedTokens: z.number().int().nonnegative(),
    }),
    z.strictObject({
        ...control,
        ...ownership,
        type: z.literal('attempt'),
        attemptId: idSchema,
        planId: idSchema,
        messageId: idSchema,
        purpose: z.enum(['chat', 'compaction']),
    }),
    z.strictObject({
        ...control,
        ...ownership,
        type: z.literal('chunk'),
        attemptId: idSchema,
        index: z.number().int().nonnegative(),
        text: z.string().min(1).max(1048576),
        channel: z.enum(['text', 'reasoning', 'continuation']).optional(),
    }),
    z.strictObject({
        ...control,
        ...ownership,
        type: z.literal('finishAttempt'),
        attemptId: idSchema,
        outcome: z.enum(['completed', 'failed']),
        usage: tokenUsageSchema,
        failure: failureSchema.optional(),
    }),
    z.strictObject({
        ...control,
        ...ownership,
        type: z.literal('end'),
        outcome: z.enum(['completed', 'failed']),
        failure: failureSchema.optional(),
    }),
    z.strictObject({
        ...control,
        ...ownership,
        type: z.literal('interrupt'),
        reason: z.enum(['user', 'aborted', 'consumer-closed']),
    }),
    z.strictObject({ ...control, type: z.literal('resume') }),
    z.strictObject({ ...control, type: z.literal('recover') }),
    z.strictObject({
        ...control,
        type: z.literal('task'),
        task: taskSchema,
        expectedRevision: idSchema.nullable(),
    }),
    z.strictObject({
        ...control,
        ...ownership,
        type: z.literal('compact'),
        compactionId: idSchema,
        epoch: epochSchema,
        retainedIds: z.array(idSchema),
        expectedContextVersion: z.string(),
    }),
    z.strictObject({
        ...control,
        ...ownership,
        type: z.literal('finishCompaction'),
        compactionId: idSchema,
        attemptId: idSchema,
    }),
]);

export type AgentRecord = z.infer<typeof recordSchema>;
export type Fact = z.infer<typeof factSchema>;
export type Command = z.infer<typeof commandSchema>;
export type Epoch = z.infer<typeof epochSchema>;
export type Delivery = z.infer<typeof deliverySchema>;
export type Task = z.infer<typeof taskSchema>;

export interface AgentStore {
    execute(command: Command): Promise<AgentRecord[]>;
    read(sessionId: string): Promise<AgentRecord[]>;
}
