import { bashTool } from './bash.js';
import { editTool } from './edit.js';
import { createFetchTool } from './fetch-tool.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { readTool } from './read.js';
import { writeTool } from './write.js';

import type { ToolDefinition } from '@whimkit/core/plugin';

/**
 * The base tools every agent has: workspace files, shell, search, and local web fetch. Local
 * web search waits for a keyed search API; scraping a search engine's pages is unreliable and
 * against their intent.
 * @param version Application version, sent in the WebFetch user agent.
 * @returns Definitions in declaration order.
 */
export function baseTools(version: string): ToolDefinition<unknown>[] {
    return [
        bashTool,
        readTool,
        writeTool,
        editTool,
        globTool,
        grepTool,
        createFetchTool({ fetch, version }),
    ];
}
