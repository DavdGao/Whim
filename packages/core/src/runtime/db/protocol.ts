import { z } from 'zod';

import { idSchema } from '../../contracts/card.js';
import { commandSchema } from '../commands.js';

export const credentialRowSchema = z.strictObject({
    id: idSchema,
    typeId: idSchema,
    label: z.string().min(1).max(200),
    plainValues: z.record(z.string(), z.unknown()),
    createdAt: z.iso.datetime(),
});
export type CredentialRow = z.infer<typeof credentialRowSchema>;

export const pluginRowSchema = z.strictObject({
    id: idSchema,
    version: z.string().min(1),
    source: z.enum(['bundled', 'local']),
    installedAt: z.iso.datetime(),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    enabled: z.boolean(),
});
export type PluginRow = z.infer<typeof pluginRowSchema>;

export const sessionSummarySchema = z.strictObject({
    sessionId: idSchema,
    title: z.string(),
    cardId: idSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
    head: z.number().int(),
    running: z.boolean(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

/** A schedule delivering a message into its session (design.md §4.1.1). */
export const scheduleRowSchema = z.strictObject({
    id: idSchema,
    sessionId: idSchema,
    name: z.string().min(1).max(80),
    message: z.string().min(1).max(4000),
    timing: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('at'), at: z.iso.datetime() }),
        z.strictObject({ kind: z.literal('cron'), cron: z.string(), timezone: z.string() }),
    ]),
    missed: z.enum(['skip', 'once']),
    paused: z.boolean(),
    /** When it fires next; null while paused or after a single fire. */
    nextFire: z.iso.datetime().nullable(),
    lastFire: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
});
export type ScheduleRow = z.infer<typeof scheduleRowSchema>;

/** An information source: a long-lived agent session made from a template (design.md §4.2). */
export const sourceRowSchema = z.strictObject({
    /** Short and readable, so agents can name it: lowercase letters, digits, and `-`. */
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
    sessionId: idSchema,
    template: idSchema,
    name: z.string().min(1).max(60),
    createdAt: z.iso.datetime(),
});
export type SourceRow = z.infer<typeof sourceRowSchema>;

const id = z.number().int().nonnegative();

/** Requests from the async store to its DB worker. */
export const requestSchema = z.discriminatedUnion('op', [
    z.strictObject({ id, op: z.literal('execute'), command: commandSchema }),
    z.strictObject({
        id,
        op: z.literal('read'),
        sessionId: idSchema,
        afterSeq: z.number().int().nonnegative(),
    }),
    z.strictObject({ id, op: z.literal('view'), sessionId: idSchema }),
    z.strictObject({ id, op: z.literal('sessions') }),
    z.strictObject({ id, op: z.literal('recovery-sessions') }),
    z.strictObject({ id, op: z.literal('session.delete'), sessionId: idSchema }),
    z.strictObject({ id, op: z.literal('setting.get'), key: z.string().min(1) }),
    z.strictObject({
        id,
        op: z.literal('setting.set'),
        key: z.string().min(1),
        value: z.unknown(),
    }),
    z.strictObject({ id, op: z.literal('credential.list') }),
    z.strictObject({
        id,
        op: z.literal('credential.put'),
        credential: credentialRowSchema,
        secrets: z.record(z.string(), z.instanceof(Uint8Array)),
        removeSecrets: z.array(z.string()),
    }),
    z.strictObject({ id, op: z.literal('credential.delete'), credentialId: idSchema }),
    z.strictObject({ id, op: z.literal('secret.get'), credentialId: idSchema }),
    z.strictObject({ id, op: z.literal('plugin.list') }),
    z.strictObject({ id, op: z.literal('plugin.put'), plugin: pluginRowSchema }),
    z.strictObject({ id, op: z.literal('schedule.list'), sessionId: idSchema.optional() }),
    z.strictObject({ id, op: z.literal('schedule.put'), schedule: scheduleRowSchema }),
    z.strictObject({ id, op: z.literal('schedule.delete'), scheduleId: idSchema }),
    z.strictObject({
        id,
        op: z.literal('schedule.fire'),
        scheduleId: idSchema,
        /** The fire time the caller read; a schedule changed since then is left alone. */
        due: z.iso.datetime(),
        next: z.iso.datetime().nullable(),
        /** The delivery to commit with the fire; absent when a missed fire is skipped. */
        command: commandSchema.optional(),
    }),
    z.strictObject({ id, op: z.literal('source.list') }),
    z.strictObject({ id, op: z.literal('source.put'), source: sourceRowSchema }),
    /** Delete a source with its session's journal, receipts, and schedules. */
    z.strictObject({ id, op: z.literal('source.delete'), sourceId: idSchema }),
    z.strictObject({ id, op: z.literal('close') }),
]);
export type Request = z.infer<typeof requestSchema>;
export type RequestInput = Request extends infer R
    ? R extends Request
        ? Omit<R, 'id'>
        : never
    : never;

export interface WorkerError {
    readonly type: 'error';
    readonly id: number;
    readonly code: 'conflict' | 'not-found' | 'invalid' | 'unreadable' | 'internal';
    readonly message: string;
}
