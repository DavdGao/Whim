import { stat } from 'node:fs/promises';

import { hasErrorCode } from './paths.js';

import type { FileVersion } from '@whimkit/core/contracts';
import type { ToolContext } from '@whimkit/core/plugin';

/**
 * A file's current version.
 * @param path Absolute path.
 * @returns Its version, or undefined when it does not exist.
 */
export async function versionOf(path: string): Promise<FileVersion | undefined> {
    try {
        const info = await stat(path);
        return { path, mtimeMs: info.mtimeMs, size: info.size };
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return undefined;
        throw error;
    }
}

/**
 * Why an existing file must not be changed yet: the model has not read it since the last
 * compaction, or it changed after the model's last read or write.
 * @param current The file's current version.
 * @param context The tool context with the versions the model has seen.
 * @returns The error for the model, or undefined when the change may proceed.
 */
export function unseenChange(current: FileVersion, context: ToolContext): string | undefined {
    const known = context.knownFiles.get(current.path);
    if (!known)
        return `Read ${current.path} before changing it, so the change is based on its current content.`;
    if (known.mtimeMs !== current.mtimeMs || known.size !== current.size)
        return `${current.path} changed since you last read it. Read it again, then make the change.`;
    return undefined;
}
