import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { defineTool } from '@whimkit/core/plugin';

import { resolve } from './paths.js';
import { runRipgrep } from './ripgrep.js';

export interface GlobInput {
    readonly pattern: string;
    readonly path?: string;
}

const maxResults = 200;
/** Upper bound on files collected for sorting, so huge trees stay bounded. */
const maxCollected = 50_000;
const statBatch = 64;

/**
 * Read modification times for files, in bounded batches.
 * @param root Directory the paths are relative to.
 * @param files Relative paths.
 * @param signal Aborts between batches.
 * @returns Paths with their mtime in milliseconds; files that vanished are dropped.
 */
async function withModifiedTimes(
    root: string,
    files: readonly string[],
    signal: AbortSignal
): Promise<{ file: string; mtimeMs: number }[]> {
    const result: { file: string; mtimeMs: number }[] = [];
    for (let i = 0; i < files.length; i += statBatch) {
        signal.throwIfAborted();
        const batch = await Promise.all(
            files.slice(i, i + statBatch).map(async file => {
                try {
                    return { file, mtimeMs: (await stat(join(root, file))).mtimeMs };
                } catch {
                    // The file was removed after listing; it no longer exists, so skip it.
                    return undefined;
                }
            })
        );
        for (const entry of batch) {
            if (entry) {
                result.push(entry);
            }
        }
    }
    return result;
}

export const globTool = defineTool<GlobInput>({
    name: 'Glob',
    description: [
        'Find files by name pattern. Returns paths relative to the search directory, newest modification first.',
        '',
        '- `pattern` is a glob such as `**/*.ts`, `src/**/test_*.py`, or `*.md`. A pattern without a slash matches the file name at any depth.',
        '- `path` is the directory to search (absolute, or relative to the workspace); it defaults to the workspace root.',
        '- Respects .gitignore and includes hidden files, except the .git directory.',
        '- At most 200 paths are returned; narrow the pattern when the result says more exist.',
        '- To search file contents use Grep; do not use `find` or `ls` in Bash for this.',
    ].join('\n'),
    inputSchema: {
        type: 'object',
        properties: {
            pattern: { type: 'string', minLength: 1, description: 'Glob pattern to match.' },
            path: { type: 'string', minLength: 1, description: 'Directory to search.' },
        },
        required: ['pattern'],
        additionalProperties: false,
    },
    readOnly: true,
    concurrencySafe: true,
    needsWorkspace: true,
    access: (input, env) => [{ kind: 'read', path: resolve(env, input.path ?? '.') }],
    async execute(input, context) {
        const root = resolve(context, input.path ?? '.');
        let info;
        try {
            info = await stat(root);
        } catch {
            return { content: `Directory not found: ${root}`, isError: true };
        }
        if (!info.isDirectory()) {
            return { content: `${root} is not a directory.`, isError: true };
        }

        // The exclusion goes last: later globs take precedence over earlier ones.
        const result = await runRipgrep(
            ['--files', '--hidden', '--glob', input.pattern, '--glob', '!.git'],
            root,
            maxCollected,
            context.signal
        );
        if (result.code === 2 && result.lines.length === 0) {
            return { content: `ripgrep failed: ${result.stderr}`, isError: true };
        }
        if (result.lines.length === 0) {
            return { content: `No files match "${input.pattern}" in ${root}.` };
        }

        const files = await withModifiedTimes(root, result.lines, context.signal);
        files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));
        const shown = files.slice(0, maxResults).map(entry => entry.file);
        const notes: string[] = [];
        if (files.length > maxResults || result.truncated) {
            notes.push(
                `[Showing the ${maxResults} newest of ${result.truncated ? 'more than ' : ''}${files.length} matches; more results exist. Narrow the pattern or path.]`
            );
        }
        if (result.code === 2) {
            notes.push(`[ripgrep reported errors: ${result.stderr}]`);
        }
        return { content: [...shown, ...notes].join('\n') };
    },
});
