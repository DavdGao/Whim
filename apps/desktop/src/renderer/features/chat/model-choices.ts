import type { AppState } from '../../../shared/ipc';
import type { ChatCard } from '@whimkit/core/contracts';

export interface ModelChoice {
    readonly card: ChatCard;
    readonly credentialId: string;
}

/**
 * Valid cards that some credential can use, each paired with a credential.
 * @param state Application state.
 * @param preferred Credential to prefer when compatible.
 * @returns Selectable models.
 */
export function modelChoices(state: AppState, preferred?: string): ModelChoice[] {
    const choices: ModelChoice[] = [];
    for (const entry of state.catalog) {
        if (!entry.card || entry.hidden) continue;
        const adapter = state.adapters.find(item => item.id === entry.card?.adapter);
        const compatible = state.credentials.filter(
            credential =>
                credential.available && adapter?.credentialTypes.includes(credential.typeId)
        );
        const credential = compatible.find(item => item.id === preferred) ?? compatible[0];
        if (credential) choices.push({ card: entry.card, credentialId: credential.id });
    }
    return choices;
}
