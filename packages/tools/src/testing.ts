import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ToolContext } from '@whimkit/core/plugin';

/**
 * Create a real temporary workspace directory.
 * @returns Its canonical path and a cleanup function.
 */
export async function createWorkspace(): Promise<{ dir: string; cleanup(): Promise<void> }> {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'whim-workspace-')));
    return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * Build a tool context that records streamed output.
 * @param workspace Workspace directory.
 * @param signal Optional abort signal.
 * @returns The context and the chunks recorded so far.
 */
export function createContext(
    workspace: string | undefined,
    signal: AbortSignal = new AbortController().signal
): { context: ToolContext; chunks: string[] } {
    const chunks: string[] = [];
    return {
        chunks,
        context: {
            workspace,
            signal,
            sessionId: 'session-1',
            callId: 'call-1',
            output: chunk => {
                chunks.push(chunk);
            },
        },
    };
}
