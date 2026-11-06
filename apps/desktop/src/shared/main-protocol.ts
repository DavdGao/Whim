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

/** Directories Main may serve as `whim-plugin://plugins/<pluginId>/` (design.md §5.7). */
export const pluginClientsSchema = z.strictObject({
    type: z.literal('plugin-clients'),
    clients: z.array(z.strictObject({ pluginId: z.string().min(1), root: z.string().min(1) })),
    /** Theme background images, served at `whim-plugin://themes/<pluginId>/<themeId>`. */
    themeImages: z.array(
        z.strictObject({
            pluginId: z.string().min(1),
            themeId: z.string().min(1),
            path: z.string().min(1),
            mediaType: z.string().min(1),
        })
    ),
});
export type PluginClients = z.infer<typeof pluginClientsSchema>;

/**
 * The URL a plugin's client file is loaded from.
 * @param pluginId The plugin.
 * @param file The file, relative to the plugin's client directory.
 * @returns The `whim-plugin:` URL.
 */
export function pluginClientUrl(pluginId: string, file: string): string {
    return `whim-plugin://plugins/${encodeURIComponent(pluginId)}/${file}`;
}

/**
 * The URL of a theme's background image.
 * @param pluginId The plugin.
 * @param themeId The theme, within the plugin.
 * @returns The `whim-plugin:` URL.
 */
export function themeImageUrl(pluginId: string, themeId: string): string {
    return `whim-plugin://themes/${encodeURIComponent(pluginId)}/${encodeURIComponent(themeId)}`;
}

/** A committed fact that needs the user, shown as a notification while no window is focused. */
export const attentionSchema = z.strictObject({
    type: z.literal('attention'),
    sessionId: z.string().min(1),
    title: z.string(),
    kind: z.enum(['completed', 'failed', 'waiting']),
});
export type Attention = z.infer<typeof attentionSchema>;
