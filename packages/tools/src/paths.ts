import { randomUUID } from 'node:crypto';
import { chmod, mkdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, resolve as resolvePath } from 'node:path';

import type { ToolEnv } from '@whimkit/core/plugin';

/**
 * Resolve a tool path: absolute paths are kept (normalized), relative ones are
 * interpreted against the session workspace.
 * @param env Tool environment carrying the workspace.
 * @param path Path given by the model.
 * @returns Absolute normalized path.
 * @throws When the path is relative and the session has no workspace.
 */
export function resolve(env: ToolEnv, path: string): string {
    if (isAbsolute(path)) {
        return normalize(path);
    }
    if (env.workspace === undefined) {
        throw new Error(`Cannot resolve relative path "${path}": this session has no workspace.`);
    }
    return resolvePath(env.workspace, path);
}

/**
 * Whether an error is a Node system error with the given code.
 * @param error Caught value.
 * @param code Errno code such as `ENOENT`.
 * @returns True when the code matches.
 */
export function hasErrorCode(error: unknown, code: string): boolean {
    return error instanceof Error && 'code' in error && error.code === code;
}

/**
 * Write a file atomically: temp file in the same directory, then rename. Parent
 * directories are created, symlinks are followed, and an existing mode is kept.
 * @param path Absolute target path.
 * @param content New file content.
 * @returns Whether the file was created or overwritten, and the byte count written.
 */
export async function writeFileAtomic(
    path: string,
    content: string
): Promise<{ readonly created: boolean; readonly bytes: number }> {
    let target = path;
    let mode: number | undefined;
    try {
        target = await realpath(path);
        const info = await stat(target);
        if (info.isDirectory()) {
            throw new Error(`${path} is a directory.`);
        }
        mode = info.mode & 0o7777;
    } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) {
            throw error;
        }
    }
    await mkdir(dirname(target), { recursive: true });
    const temp = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
    try {
        await writeFile(temp, content, 'utf8');
        if (mode !== undefined) {
            await chmod(temp, mode);
        }
        await rename(temp, target);
    } catch (error) {
        await rm(temp, { force: true });
        throw error;
    }
    return { created: mode === undefined, bytes: Buffer.byteLength(content, 'utf8') };
}
