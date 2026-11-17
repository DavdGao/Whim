import { z } from 'zod';

import { idSchema } from './card.js';

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
