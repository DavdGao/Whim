import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';

import { sniffImage } from '@whimkit/core/contracts';
import { defineTool } from '@whimkit/core/plugin';

import { hasErrorCode, resolve } from './paths.js';

export interface ReadInput {
    readonly path: string;
    readonly offset?: number;
    readonly limit?: number;
}

const defaultLimit = 2000;
const maxLineChars = 2000;
const binarySniffBytes = 8192;

/**
 * Whether the start of a file looks binary (contains a NUL byte).
 * @param path Absolute file path.
 * @returns True when a NUL byte occurs in the first 8 KiB.
 */
async function looksBinary(path: string): Promise<boolean> {
    const handle = await open(path, 'r');
    try {
        const buffer = Buffer.alloc(binarySniffBytes);
        const { bytesRead } = await handle.read(buffer, 0, binarySniffBytes, 0);
        return buffer.subarray(0, bytesRead).includes(0);
    } finally {
        await handle.close();
    }
}

/** Images above this size are described instead of attached. */
const maxImageBytes = 10 * 1024 * 1024;

/**
 * Open an image for the model: PNG, JPEG, WebP, or GIF by signature, within the size limit.
 * @param path The file.
 * @param size Its size in bytes.
 * @returns The bytes and type, or undefined for other files.
 */
async function readImage(
    path: string,
    size: number
): Promise<{ mediaType: string; data: Uint8Array } | undefined> {
    if (size > maxImageBytes) return undefined;
    const handle = await open(path, 'r');
    try {
        const head = new Uint8Array(16);
        await handle.read(head, 0, head.length, 0);
        const mediaType = sniffImage(head);
        if (!mediaType) return undefined;
        return { mediaType, data: new Uint8Array(await handle.readFile()) };
    } finally {
        await handle.close();
    }
}

/**
 * Format one line with a right-aligned line number and a long-line marker.
 * @param lineNumber 1-based line number.
 * @param line Line text without terminator.
 * @returns The `cat -n` style line.
 */
function formatLine(lineNumber: number, line: string): string {
    const text =
        line.length > maxLineChars
            ? `${line.slice(0, maxLineChars)}... [line truncated, ${line.length} characters]`
            : line;
    return `${String(lineNumber).padStart(6, ' ')}\t${text}`;
}

export const readTool = defineTool<ReadInput>({
    name: 'Read',
    description: [
        'Read a text file from the local filesystem. Returns lines prefixed with 1-based line numbers (`cat -n` format).',
        '',
        '- `path` is absolute, or relative to the workspace. Files outside the workspace may be read; the user is asked first.',
        '- By default up to 2000 lines are returned. Use `offset` (1-based first line) and `limit` (line count) to read a window of a large file; the result says how to continue when more lines remain.',
        '- Lines longer than 2000 characters are cut and marked.',
        '- PNG, JPEG, WebP, and GIF images up to 10 MiB are returned as images. Directories are refused (use Glob to list files). Other binary files are refused.',
        '- Read before you Edit a file so that `old_string` matches exactly. Prefer Read over `cat` in Bash.',
    ].join('\n'),
    inputSchema: {
        type: 'object',
        properties: {
            path: { type: 'string', minLength: 1, description: 'File to read.' },
            offset: { type: 'integer', minimum: 1, description: 'First line to return, 1-based.' },
            limit: { type: 'integer', minimum: 1, description: 'Maximum number of lines.' },
        },
        required: ['path'],
        additionalProperties: false,
    },
    readOnly: true,
    concurrencySafe: true,
    // Offered without a workspace too: offloaded tool results are read by absolute path.
    needsWorkspace: false,
    access: (input, env) => [{ kind: 'read', path: resolve(env, input.path) }],
    async execute(input, context) {
        const path = resolve(context, input.path);
        let info;
        try {
            info = await stat(path);
        } catch (error) {
            if (hasErrorCode(error, 'ENOENT')) {
                return { content: `File not found: ${path}`, isError: true };
            }
            throw error;
        }
        if (info.isDirectory()) {
            return {
                content: `${path} is a directory, not a file. Use Glob to list its files.`,
                isError: true,
            };
        }
        const image = await readImage(path, info.size);
        if (image) {
            return {
                content: `${path} is an image (${image.mediaType}, ${info.size} bytes); it is attached to this result.`,
                media: [{ mediaType: image.mediaType, data: image.data, name: basename(path) }],
            };
        }
        if (await looksBinary(path)) {
            return {
                content: `${path} looks like a binary file (${info.size} bytes); refusing to read it as text.`,
                isError: true,
            };
        }

        const first = input.offset ?? 1;
        const limit = input.limit ?? defaultLimit;
        const last = first + limit - 1;
        const stream = createReadStream(path, { encoding: 'utf8', signal: context.signal });
        const lines = createInterface({ input: stream, crlfDelay: Infinity });
        const window: string[] = [];
        let lineNumber = 0;
        let more = false;
        try {
            for await (const line of lines) {
                lineNumber += 1;
                if (lineNumber < first) {
                    continue;
                }
                if (lineNumber > last) {
                    more = true;
                    break;
                }
                window.push(formatLine(lineNumber, line));
            }
        } finally {
            lines.close();
            stream.destroy();
        }
        context.signal.throwIfAborted();

        if (window.length === 0) {
            return {
                content:
                    lineNumber === 0
                        ? `${path} is empty.`
                        : `${path} has only ${lineNumber} lines; offset ${first} is past the end.`,
                isError: lineNumber !== 0,
            };
        }
        const end = first + window.length - 1;
        const footer = more
            ? `\n[Showing lines ${first}-${end}; more lines follow. Continue with offset=${end + 1}.]`
            : `\n[End of file: ${lineNumber} lines in total.]`;
        return { content: window.join('\n') + footer };
    },
});
