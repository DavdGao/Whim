import { createFetchTool } from './fetch-tool.js';

import type { WebToolsOptions } from './http.js';

/**
 * Create the local web tools. Local web search waits for a keyed search API; scraping a
 * search engine's HTML pages is unreliable and against their intent.
 * @param options Transport and application version.
 * @returns The WebFetch definition.
 */
export function createWebTools(options: WebToolsOptions): {
    webFetch: ReturnType<typeof createFetchTool>;
} {
    return { webFetch: createFetchTool(options) };
}
