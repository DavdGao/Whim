import { pluginText } from '../../lib/messages';

import type { AppState } from '../../../shared/ipc';
import type { ChatCard } from '@whimkit/core/contracts';

export interface ModelChoice {
    readonly card: ChatCard;
    readonly credentialId: string;
    /** Display name of the plugin providing the model. */
    readonly provider: string;
}

/**
 * Valid cards that some credential can use, each paired with a credential, grouped by provider.
 * @param state Application state.
 * @param preferred Credential to prefer when compatible.
 * @returns Selectable models, ordered by provider.
 */
export function modelChoices(state: AppState, preferred?: string): ModelChoice[] {
    const locale = state.locale;
    const choices: ModelChoice[] = [];
    for (const entry of state.catalog) {
        if (!entry.card || entry.hidden) continue;
        const adapter = state.adapters.find(item => item.id === entry.card?.adapter);
        const compatible = state.credentials.filter(
            credential =>
                credential.available && adapter?.credentialTypes.includes(credential.typeId)
        );
        const credential = compatible.find(item => item.id === preferred) ?? compatible[0];
        const plugin = state.plugins.find(item => item.id === adapter?.pluginId);
        if (credential && plugin)
            choices.push({
                card: entry.card,
                credentialId: credential.id,
                provider: pluginText(plugin.locales, locale, 'plugin.name', plugin.id),
            });
    }
    // Stable sort keeps catalog order within a provider.
    return choices.sort((a, b) => a.provider.localeCompare(b.provider, locale));
}
