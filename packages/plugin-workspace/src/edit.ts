import { readFile } from 'node:fs/promises';

import { defineTool } from '@whimkit/core/plugin';

import { hasErrorCode, resolve, writeFileAtomic } from './paths.js';

export interface EditInput {
    readonly path: string;
    readonly old_string: string;
    readonly new_string: string;
    readonly replace_all?: boolean;
}

const snippetContext = 3;

/**
 * Count non-overlapping occurrences of a needle.
 * @param text Haystack.
 * @param needle Non-empty search string.
 * @returns Number of occurrences.
 */
function countOccurrences(text: string, needle: string): number {
    let count = 0;
    let index = text.indexOf(needle);
    while (index !== -1) {
        count += 1;
        index = text.indexOf(needle, index + needle.length);
    }
    return count;
}

/**
 * Render numbered lines around the first change.
 * @param updated Full updated file content.
 * @param changeIndex Character index of the first change in `updated`.
 * @param changedLines Number of lines the replacement text spans.
 * @returns A numbered snippet.
 */
function snippet(updated: string, changeIndex: number, changedLines: number): string {
    const firstChanged = updated.slice(0, changeIndex).split('\n').length;
    const lines = updated.split('\n');
    const from = Math.max(1, firstChanged - snippetContext);
    const to = Math.min(lines.length, firstChanged + changedLines - 1 + snippetContext);
    const rows: string[] = [];
    for (let n = from; n <= to; n += 1) {
        rows.push(`${String(n).padStart(6, ' ')}\t${(lines[n - 1] ?? '').replace(/\r$/, '')}`);
    }
    return rows.join('\n');
}

export const editTool = defineTool<EditInput>({
    name: 'Edit',
    description: [
        'Replace exact text in an existing file.',
        '',
        '- `path` is absolute, or relative to the workspace. Read the file first so `old_string` matches it exactly, including whitespace; do not include the line-number prefix that Read adds.',
        '- `old_string` must be non-empty, differ from `new_string`, and occur exactly once in the file. If it is ambiguous, add surrounding context to make it unique, or set `replace_all` to replace every occurrence (for example to rename a variable).',
        "- The file's line endings are preserved; in a CRLF file, LF line breaks in `old_string` and `new_string` are matched and written as CRLF.",
        '- The write is atomic. The result shows the changed region with line numbers.',
        '- To create a file or replace it entirely, use Write.',
    ].join('\n'),
    inputSchema: {
        type: 'object',
        properties: {
            path: { type: 'string', minLength: 1, description: 'File to edit.' },
            old_string: { type: 'string', minLength: 1, description: 'Exact text to replace.' },
            new_string: { type: 'string', description: 'Replacement text.' },
            replace_all: {
                type: 'boolean',
                description: 'Replace every occurrence instead of requiring a unique match.',
            },
        },
        required: ['path', 'old_string', 'new_string'],
        additionalProperties: false,
    },
    readOnly: false,
    concurrencySafe: false,
    needsWorkspace: true,
    access: (input, env) => [{ kind: 'write', path: resolve(env, input.path) }],
    async execute(input, context) {
        const path = resolve(context, input.path);
        if (input.old_string === '') {
            return { content: 'old_string must not be empty.', isError: true };
        }
        if (input.old_string === input.new_string) {
            return {
                content: 'old_string and new_string are identical; nothing to do.',
                isError: true,
            };
        }
        let original: string;
        try {
            original = await readFile(path, { encoding: 'utf8', signal: context.signal });
        } catch (error) {
            if (hasErrorCode(error, 'ENOENT')) {
                return { content: `File not found: ${path}`, isError: true };
            }
            if (hasErrorCode(error, 'EISDIR')) {
                return { content: `${path} is a directory, not a file.`, isError: true };
            }
            throw error;
        }

        let oldString = input.old_string;
        let newString = input.new_string;
        let count = countOccurrences(original, oldString);
        // Models write LF; in a CRLF file, match and replace with the file's own line endings.
        if (count === 0 && original.includes('\r\n') && !oldString.includes('\r\n')) {
            oldString = oldString.replaceAll('\n', '\r\n');
            newString = newString.replace(/\r?\n/g, '\r\n');
            count = countOccurrences(original, oldString);
        }
        if (count === 0) return { content: `old_string was not found in ${path}.`, isError: true };
        if (count > 1 && input.replace_all !== true) {
            return {
                content: `old_string occurs ${count} times in ${path}. Add surrounding context to make it unique, or set replace_all to replace every occurrence.`,
                isError: true,
            };
        }

        const changeIndex = original.indexOf(oldString);
        const updated = original.split(oldString).join(newString);
        context.signal.throwIfAborted();
        await writeFileAtomic(path, updated);

        const replaced = input.replace_all === true ? count : 1;
        const changedLines = newString.split('\n').length;
        return {
            content: `Replaced ${replaced} occurrence${replaced === 1 ? '' : 's'} in ${path}. First change:\n${snippet(updated, changeIndex, changedLines)}`,
        };
    },
});
