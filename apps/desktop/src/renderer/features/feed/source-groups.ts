import type { AppState, SourceInfo } from '../../../shared/ipc';

interface SourceGroup {
    readonly id: 'ready' | 'invalid' | 'unconfigured';
    readonly sources: SourceInfo[];
}

/**
 * Order sources by usability, distinguishing absent configuration from a broken connection.
 * @param state Current source health and saved connection settings.
 * @returns Nonempty groups in display order, preserving source order within each group.
 */
export function groupSources(
    state: Pick<AppState, 'sources' | 'credentials' | 'mcpServers'>
): SourceGroup[] {
    const ready: SourceInfo[] = [];
    const invalid: SourceInfo[] = [];
    const unconfigured: SourceInfo[] = [];
    for (const source of state.sources) {
        const { state: health, fix } = source.health;
        if (health === 'ready') ready.push(source);
        else if (
            health === 'needs-setup' &&
            ((fix?.kind === 'credential' &&
                !state.credentials.some(credential => credential.typeId === fix.typeId)) ||
                (fix?.kind === 'mcp' && !state.mcpServers.some(server => server.id === fix.server)))
        )
            unconfigured.push(source);
        else invalid.push(source);
    }
    const groups: SourceGroup[] = [
        { id: 'ready', sources: ready },
        { id: 'invalid', sources: invalid },
        { id: 'unconfigured', sources: unconfigured },
    ];
    return groups.filter(group => group.sources.length > 0);
}
