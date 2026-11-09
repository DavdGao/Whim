import { pluginText } from '../../lib/messages';

import type { AppState, CodingAgentInfo } from '../../../shared/ipc';

/**
 * A coding agent's display name from its plugin's catalogs.
 * @param state Application state.
 * @param agent The agent.
 * @returns The name.
 */
export function agentName(state: AppState, agent: CodingAgentInfo): string {
    const plugin = state.plugins.find(item => item.id === agent.pluginId);
    return pluginText(plugin?.locales, state.locale, agent.name, agent.id);
}
