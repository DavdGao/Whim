import { execFile } from 'node:child_process';

import type { GitStatus } from '../shared/ipc.js';

/**
 * Run one read-only git command. Optional locks are skipped so a concurrent git process is
 * never blocked, and fsmonitor is off so repository config cannot run a program.
 * @param cwd The folder.
 * @param args Git arguments.
 * @param signal Cancellation.
 * @returns Standard output, or undefined when git fails.
 */
function git(
    cwd: string,
    args: readonly string[],
    signal: AbortSignal
): Promise<string | undefined> {
    return new Promise(resolve => {
        execFile(
            'git',
            ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args],
            { cwd, signal, timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
            (error, stdout) => resolve(error ? undefined : stdout)
        );
    });
}

/**
 * Read a folder's git status for display.
 * @param cwd An absolute folder.
 * @param signal Cancellation.
 * @returns The status, or null when the folder is not in a repository or git is unavailable.
 */
export async function gitStatus(cwd: string, signal: AbortSignal): Promise<GitStatus | null> {
    const status = await git(
        cwd,
        ['status', '--porcelain=v2', '--branch', '--untracked-files=no'],
        signal
    );
    if (status === undefined) return null;
    const branch = /^# branch\.head (.+)$/m.exec(status)?.[1];
    const oid = /^# branch\.oid (.+)$/m.exec(status)?.[1];
    const head =
        branch && branch !== '(detached)'
            ? branch
            : oid && oid !== '(initial)'
              ? oid.slice(0, 7)
              : undefined;
    if (!head) return null;
    // Staged and unstaged changes against HEAD; a repository without commits has none to count.
    const numstat =
        oid === '(initial)' ? '' : ((await git(cwd, ['diff', 'HEAD', '--numstat'], signal)) ?? '');
    let insertions = 0;
    let deletions = 0;
    for (const line of numstat.split('\n')) {
        const [added, removed] = line.split('\t');
        // Binary files report "-".
        if (added && added !== '-') insertions += Number(added);
        if (removed && removed !== '-') deletions += Number(removed);
    }
    return { head, insertions, deletions };
}
