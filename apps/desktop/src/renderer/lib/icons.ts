import type { AppState } from '../../shared/ipc';

/**
 * The image for a model: its card icon from the adapter's plugin, else that plugin's logo.
 * @param state Application state.
 * @param card The card's adapter and optional icon key.
 * @param card.adapter The adapter id.
 * @param card.icon The icon key.
 * @returns A data URL, or undefined for the generic glyph.
 */
export function modelIcon(
    state: AppState,
    card: { readonly adapter: string; readonly icon?: unknown }
): string | undefined {
    const pluginId = state.adapters.find(item => item.id === card.adapter)?.pluginId;
    const plugin = state.plugins.find(item => item.id === pluginId);
    return (typeof card.icon === 'string' ? plugin?.icons[card.icon] : undefined) ?? plugin?.icon;
}
