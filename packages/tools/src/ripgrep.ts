import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import { rgPath } from '@vscode/ripgrep';

export interface RipgrepResult {
    readonly lines: readonly string[];
    readonly stderr: string;
    /** Exit code; `null` when ripgrep was stopped because `maxLines` was reached. */
    readonly code: number | null;
    /** More output existed than `maxLines`. */
    readonly truncated: boolean;
}

const maxStderrChars = 16 * 1024;

/**
 * The binary to spawn. In a packaged app the resolved path points inside `app.asar`, which only
 * Electron's fs can read; the executable itself is unpacked next to it (design.md §13.1).
 */
const ripgrepPath = rgPath.replace(/\.asar([\\/])/, '.asar.unpacked$1');

/**
 * Run ripgrep with an argument array and collect at most `maxLines` stdout lines.
 * When the limit is reached ripgrep is stopped, so output memory stays bounded.
 * @param args ripgrep arguments (never interpreted by a shell).
 * @param cwd Working directory.
 * @param maxLines Maximum stdout lines to keep.
 * @param signal Aborts the process.
 * @returns Collected lines, stderr, exit code, and whether output was cut.
 * @throws When ripgrep cannot be spawned or the signal aborts.
 */
export async function runRipgrep(
    args: readonly string[],
    cwd: string,
    maxLines: number,
    signal: AbortSignal
): Promise<RipgrepResult> {
    signal.throwIfAborted();
    const child = spawn(ripgrepPath, ['--no-config', ...args], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        signal,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
        if (stderr.length < maxStderrChars) {
            stderr += chunk;
        }
    });
    const exit = new Promise<number | null>((resolveExit, rejectExit) => {
        child.once('error', rejectExit);
        child.once('close', code => resolveExit(code));
    });

    const lines: string[] = [];
    let truncated = false;
    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    try {
        for await (const line of reader) {
            if (lines.length >= maxLines) {
                truncated = true;
                child.kill('SIGTERM');
                break;
            }
            lines.push(line);
        }
    } finally {
        reader.close();
    }
    const code = await exit;
    return { lines, stderr: stderr.trim(), code: truncated ? null : code, truncated };
}
