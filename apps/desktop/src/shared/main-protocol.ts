import { z } from 'zod';

// Messages Backend sends Main for background operation (design.md §4.1). Main imports only this
// module and zod, never Core.

export const localeSchema = z.enum(['en', 'zh-CN']);
export type Locale = z.infer<typeof localeSchema>;

/** The chats running now, derived from committed records. Replaces the previous snapshot. */
export const activitySchema = z.strictObject({
    type: z.literal('activity'),
    locale: localeSchema,
    running: z.array(
        z.strictObject({
            sessionId: z.string().min(1),
            title: z.string(),
            /** A permission ask waits for the user. */
            waiting: z.boolean(),
        })
    ),
});
export type Activity = z.infer<typeof activitySchema>;

/** A committed fact that needs the user, shown as a notification while no window is focused. */
export const attentionSchema = z.strictObject({
    type: z.literal('attention'),
    sessionId: z.string().min(1),
    title: z.string(),
    kind: z.enum(['completed', 'failed', 'waiting']),
});
export type Attention = z.infer<typeof attentionSchema>;
