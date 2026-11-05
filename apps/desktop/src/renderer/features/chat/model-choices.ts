import { pluginText } from '../../lib/messages';

import type { AppState } from '../../../shared/ipc';
import type { Card, ChatCard } from '@whimkit/core/contracts';

export interface ModelChoice<C extends Card = ChatCard> {
    readonly card: C;
    readonly credentialId: string;
    /** Display name of the plugin providing the model. */
    readonly provider: string;
}

/**
 * Valid Chat cards that some credential can use, each paired with a credential, grouped by
 * provider.
 * @param state Application state.
 * @param preferred Credential to prefer when compatible.
 * @returns Selectable models, ordered by provider.
 */
export function modelChoices(state: AppState, preferred?: string): ModelChoice[] {
    return choicesOf(state, (card): card is ChatCard => card.kind === 'chat', preferred);
}

/**
 * Cards that can review tool calls: Chat and Decision models some credential can use.
 * @param state Application state.
 * @param preferred Credential to prefer when compatible.
 * @returns Selectable models, ordered by provider.
 */
export function reviewerChoices(state: AppState, preferred?: string): ModelChoice<Card>[] {
    return choicesOf(state, (_card): _card is Card => true, preferred);
}

/**
 * Valid cards of the accepted kinds that some credential can use, grouped by provider.
 * @param state Application state.
 * @param accepts Narrows to the accepted cards.
 * @param preferred Credential to prefer when compatible.
 * @returns Selectable models, ordered by provider.
 */
function choicesOf<C extends Card>(
    state: AppState,
    accepts: (card: Card) => card is C,
    preferred?: string
): ModelChoice<C>[] {
    const locale = state.locale;
    const choices: ModelChoice<C>[] = [];
    for (const entry of state.catalog) {
        const card = entry.card;
        if (!card || entry.hidden || !accepts(card)) continue;
        const adapter = state.adapters.find(item => item.id === card.adapter);
        const compatible = state.credentials.filter(
            credential =>
                credential.available && adapter?.credentialTypes.includes(credential.typeId)
        );
        const credential = compatible.find(item => item.id === preferred) ?? compatible[0];
        const plugin = state.plugins.find(item => item.id === adapter?.pluginId);
        if (credential && plugin)
            choices.push({
                card,
                credentialId: credential.id,
                provider: pluginText(plugin.locales, locale, 'plugin.name', plugin.id),
            });
    }
    // Stable sort keeps catalog order within a provider.
    return choices.sort((a, b) => a.provider.localeCompare(b.provider, locale));
}
