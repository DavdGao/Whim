import { stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import { defineTool } from '@whimkit/core/plugin';

import { resolve } from './paths.js';
import { runRipgrep } from './ripgrep.js';

export interface GrepInput {
    readonly pattern: string;
    readonly path?: string;
    readonly glob?: string;
    readonly type?: string;
    readonly output_mode?: 'content' | 'files_with_matches' | 'count';
    readonly '-i'?: boolean;
    readonly '-n'?: boolean;
    readonly '-A'?: number;
    readonly '-B'?: number;
    readonly '-C'?: number;
    readonly multiline?: boolean;
    readonly head_limit?: number;
}

const defaultHeadLimit = 250;
/** Longest line shown; ripgrep replaces the rest with a preview. */
const maxColumns = 500;

/**
 * Build the ripgrep argument array for a Grep call.
 * @param input Validated tool input.
 * @param target Path argument ripgrep searches, relative to its working directory.
 * @returns Arguments, never a shell string.
 */
function buildArgs(input: GrepInput, target: string): string[] {
    const mode = input.output_mode ?? 'files_with_matches';
    const args = [
        '--hidden',
        '--sort',
        'path',
        '--max-columns',
        String(maxColumns),
        '--max-columns-preview',
    ];
    if (input.glob !== undefined) {
        args.push('--glob', input.glob);
    }
    // The exclusion goes after the user glob: later globs take precedence.
    args.push('--glob', '!.git');
    if (input.type !== undefined) {
        args.push('--type', input.type);
    }
    if (input['-i'] === true) {
        args.push('--ignore-case');
    }
    if (input.multiline === true) {
        args.push('--multiline', '--multiline-dotall');
    }
    if (mode === 'files_with_matches') {
        args.push('--files-with-matches');
    } else if (mode === 'count') {
        args.push('--count', '--with-filename');
    } else {
        args.push('--with-filename');
        if (input['-n'] !== false) {
            args.push('--line-number');
        }
        if (input['-A'] !== undefined) {
            args.push('--after-context', String(input['-A']));
        }
        if (input['-B'] !== undefined) {
            args.push('--before-context', String(input['-B']));
        }
        if (input['-C'] !== undefined) {
            args.push('--context', String(input['-C']));
        }
    }
    // `-e` keeps patterns that start with a dash from being parsed as flags.
    args.push('-e', input.pattern, '--', target);
    return args;
}

export const grepTool = defineTool<GrepInput>({
    name: 'Grep',
    description: [
        'Search file contents with ripgrep regular expressions (Rust regex syntax; escape literal braces such as `interface\\{\\}`).',
        '',
        '- `pattern` is the regex. `path` is a directory or file (default: the workspace root); `glob` (e.g. `*.ts`) and `type` (e.g. `ts`, `py`) filter files.',
        '- `output_mode`: `files_with_matches` (default) lists matching files; `content` shows matching lines, with line numbers unless `-n` is false, and `-A`/`-B`/`-C` lines of context; `count` shows match counts per file.',
        '- `-i` ignores case. `multiline` lets patterns span lines and `.` match newlines.',
        '- Output is capped at `head_limit` lines (default 250) and says when it was cut.',
        '- Respects .gitignore, includes hidden files except .git. No matches is a normal result, not an error.',
        '- Always use Grep for content search instead of `grep` or `rg` in Bash.',
    ].join('\n'),
    inputSchema: {
        type: 'object',
        properties: {
            pattern: {
                type: 'string',
                minLength: 1,
                description: 'Regular expression to search for.',
            },
            path: { type: 'string', minLength: 1, description: 'File or directory to search.' },
            glob: {
                type: 'string',
                minLength: 1,
                description: 'Only search files matching this glob.',
            },
            type: {
                type: 'string',
                minLength: 1,
                description: 'Only search this ripgrep file type.',
            },
            output_mode: {
                type: 'string',
                enum: ['content', 'files_with_matches', 'count'],
                description: 'What to return; default files_with_matches.',
            },
            '-i': { type: 'boolean', description: 'Case-insensitive search.' },
            '-n': {
                type: 'boolean',
                description: 'Show line numbers in content mode; default true.',
            },
            '-A': {
                type: 'integer',
                minimum: 0,
                description: 'Lines of context after each match.',
            },
            '-B': {
                type: 'integer',
                minimum: 0,
                description: 'Lines of context before each match.',
            },
            '-C': {
                type: 'integer',
                minimum: 0,
                description: 'Lines of context around each match.',
            },
            multiline: { type: 'boolean', description: 'Allow matches to span lines.' },
            head_limit: {
                type: 'integer',
                minimum: 1,
                description: 'Maximum output lines; default 250.',
            },
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
            return { content: `Path not found: ${root}`, isError: true };
        }
        const cwd = info.isDirectory() ? root : dirname(root);
        const target = info.isDirectory() ? '.' : basename(root);

        const limit = input.head_limit ?? defaultHeadLimit;
        const result = await runRipgrep(buildArgs(input, target), cwd, limit, context.signal);
        if (result.code === 2 && result.lines.length === 0) {
            return { content: `ripgrep failed: ${result.stderr}`, isError: true };
        }
        if (result.lines.length === 0) {
            return { content: `No matches for "${input.pattern}" in ${root}.` };
        }
        const lines = result.lines.map(line => (line.startsWith('./') ? line.slice(2) : line));
        if (result.truncated) {
            lines.push(
                `[Output capped at ${limit} lines; more results exist. Narrow the search or raise head_limit.]`
            );
        }
        if (result.code === 2) {
            lines.push(`[ripgrep reported errors: ${result.stderr}]`);
        }
        return { content: lines.join('\n') };
    },
});
