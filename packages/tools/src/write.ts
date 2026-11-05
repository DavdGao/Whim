import { defineTool } from '@whimkit/core/plugin';

import { resolve, writeFileAtomic } from './paths.js';
import { unseenChange, versionOf } from './versions.js';

export interface WriteInput {
    readonly path: string;
    readonly content: string;
}

export const writeTool = defineTool<WriteInput>({
    name: 'Write',
    description: [
        'Write a file to the local filesystem, creating it (and missing parent directories) or replacing it completely.',
        '',
        '- `path` is absolute, or relative to the workspace.',
        '- `content` becomes the entire file. To change part of an existing file, use Edit instead.',
        '- To overwrite an existing file, Read it first: Write fails if you have not read it in this conversation or it changed after your last Read. New files need no Read.',
        '- The write is atomic: the file is never left half-written.',
        '- Do not create documentation files unless asked.',
    ].join('\n'),
    inputSchema: {
        type: 'object',
        properties: {
            path: { type: 'string', minLength: 1, description: 'File to write.' },
            content: { type: 'string', description: 'Complete new file content.' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
    },
    readOnly: false,
    concurrencySafe: false,
    needsWorkspace: true,
    access: (input, env) => [{ kind: 'write', path: resolve(env, input.path) }],
    async execute(input, context) {
        const path = resolve(context, input.path);
        const current = await versionOf(path);
        const unseen = current && unseenChange(current, context);
        if (unseen) return { content: unseen, isError: true };
        context.signal.throwIfAborted();
        const { created, bytes } = await writeFileAtomic(path, input.content);
        const written = await versionOf(path);
        return {
            content: `${created ? 'Created' : 'Overwrote'} ${path} (${bytes} bytes).`,
            ...(written ? { files: [written] } : {}),
        };
    },
});
