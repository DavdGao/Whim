import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { versionOf } from './versions.js';

import type { FileVersion } from '@whimkit/core/contracts';
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
 * @param knownFiles File versions the model has seen.
 * @returns The context and the chunks recorded so far.
 */
export function createContext(
    workspace: string | undefined,
    signal: AbortSignal = new AbortController().signal,
    knownFiles: ReadonlyMap<string, FileVersion> = new Map()
): { context: ToolContext; chunks: string[] } {
    const chunks: string[] = [];
    return {
        chunks,
        context: {
            workspace,
            signal,
            sessionId: 'session-1',
            callId: 'call-1',
            knownFiles,
            output: chunk => {
                chunks.push(chunk);
            },
        },
    };
}

/**
 * The versions of files as if the model had just read them.
 * @param paths Absolute paths of existing files.
 * @returns Versions by path, for `createContext`.
 */
export async function seen(...paths: string[]): Promise<Map<string, FileVersion>> {
    const files = new Map<string, FileVersion>();
    for (const path of paths) {
        const version = await versionOf(path);
        if (!version) throw new Error(`${path} does not exist.`);
        files.set(path, version);
    }
    return files;
}
