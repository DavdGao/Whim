import type { AppState, SourceInfo, SourceTemplateInfo } from '../../../shared/ipc';

export type SourceCandidate =
    | { readonly kind: 'new'; readonly template: SourceTemplateInfo }
    | {
          readonly kind: 'existing';
          readonly source: SourceInfo;
          readonly template?: SourceTemplateInfo;
      };

/**
 * Show verified sources above candidates, reusing unfinished sessions instead of duplicating them.
 * @param state Available templates and the current source health.
 * @returns Ready sources and compact configuration candidates, in stable order.
 */
export function groupSources(state: Pick<AppState, 'sources' | 'sourceTemplates'>): {
    ready: SourceInfo[];
    candidates: SourceCandidate[];
} {
    const ready: SourceInfo[] = [];
    const candidates: SourceCandidate[] = [];
    const existing = new Set(state.sources.map(source => source.template));
    for (const source of state.sources) {
        if (source.health.state === 'ready' && source.health.checkedAt) ready.push(source);
        else {
            const template = state.sourceTemplates.find(item => item.id === source.template);
            candidates.push({ kind: 'existing', source, ...(template ? { template } : {}) });
        }
    }
    for (const template of state.sourceTemplates)
        if (!existing.has(template.id)) candidates.push({ kind: 'new', template });
    return { ready, candidates };
}
