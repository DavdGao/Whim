import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { readTool } from './read.js';
import { createContext, createWorkspace } from './testing.js';
import { versionOf } from './versions.js';

/**
 * Expected numbered output for lines "line N".
 * @param from First line.
 * @param to Last line.
 * @returns The joined numbered lines.
 */
function numbered(from: number, to: number): string {
    return Array.from(
        { length: to - from + 1 },
        (_, i) => `${String(from + i).padStart(6, ' ')}\tline ${from + i}`
    ).join('\n');
}

describe('Read', () => {
    it('declares access for relative and absolute paths', () => {
        assert.deepEqual(readTool.access({ path: 'a.txt' }, { workspace: '/w' }), [
            { kind: 'read', path: '/w/a.txt' },
        ]);
        assert.deepEqual(readTool.access({ path: '/etc/hosts' }, { workspace: '/w' }), [
            { kind: 'read', path: '/etc/hosts' },
        ]);
        assert.deepEqual(
            readTool.access({ path: 'file:///tmp/a%20b/out.txt' }, { workspace: '/w' }),
            [{ kind: 'read', path: '/tmp/a b/out.txt' }]
        );
    });

    it('returns a PNG as an image', async () => {
        const ws = await createWorkspace();
        try {
            const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
            await writeFile(join(ws.dir, 'shot.png'), png);
            const { context } = createContext(ws.dir);
            assert.deepEqual(await readTool.execute({ path: 'shot.png' }, context), {
                content: `${join(ws.dir, 'shot.png')} is an image (image/png, 10 bytes); it is attached to this result.`,
                media: [{ mediaType: 'image/png', data: png, name: 'shot.png' }],
                files: [await versionOf(join(ws.dir, 'shot.png'))],
            });
        } finally {
            await ws.cleanup();
        }
    });

    it('reads a whole small file with numbered lines', async () => {
        const ws = await createWorkspace();
        try {
            await writeFile(join(ws.dir, 'a.txt'), 'one\ntwo\r\nthree\n');
            const { context } = createContext(ws.dir);
            assert.deepEqual(await readTool.execute({ path: 'a.txt' }, context), {
                content:
                    '     1\tone\n     2\ttwo\n     3\tthree\n[End of file: 3 lines in total.]',
                files: [await versionOf(join(ws.dir, 'a.txt'))],
            });
        } finally {
            await ws.cleanup();
        }
    });

    it('honors offset and limit and says how to continue', async () => {
        const ws = await createWorkspace();
        try {
            const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
            await writeFile(join(ws.dir, 'a.txt'), lines.join('\n'));
            const { context } = createContext(ws.dir);
            assert.deepEqual(
                await readTool.execute({ path: 'a.txt', offset: 3, limit: 4 }, context),
                {
                    content: `${numbered(3, 6)}\n[Showing lines 3-6; more lines follow. Continue with offset=7.]`,
                    files: [await versionOf(join(ws.dir, 'a.txt'))],
                }
            );
            assert.deepEqual(
                await readTool.execute({ path: 'a.txt', offset: 9, limit: 5 }, context),
                {
                    content: `${numbered(9, 10)}\n[End of file: 10 lines in total.]`,
                    files: [await versionOf(join(ws.dir, 'a.txt'))],
                }
            );
            assert.deepEqual(await readTool.execute({ path: 'a.txt', offset: 11 }, context), {
                content: `${join(ws.dir, 'a.txt')} has only 10 lines; offset 11 is past the end.`,
                isError: true,
            });
        } finally {
            await ws.cleanup();
        }
    });

    it('applies the default limit of 2000 lines', async () => {
        const ws = await createWorkspace();
        try {
            await writeFile(
                join(ws.dir, 'big.txt'),
                Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join('\n')
            );
            const { context } = createContext(ws.dir);
            const result = await readTool.execute({ path: 'big.txt' }, context);
            assert.ok(
                result.content.endsWith(
                    '[Showing lines 1-2000; more lines follow. Continue with offset=2001.]'
                )
            );
            assert.ok(!result.content.includes('line 2001'));
        } finally {
            await ws.cleanup();
        }
    });

    it('cuts very long lines with a marker', async () => {
        const ws = await createWorkspace();
        try {
            await writeFile(join(ws.dir, 'long.txt'), 'x'.repeat(2500));
            const { context } = createContext(ws.dir);
            assert.deepEqual(await readTool.execute({ path: 'long.txt' }, context), {
                content: `     1\t${'x'.repeat(2000)}... [line truncated, 2500 characters]\n[End of file: 1 lines in total.]`,
                files: [await versionOf(join(ws.dir, 'long.txt'))],
            });
        } finally {
            await ws.cleanup();
        }
    });

    it('reports empty, missing, directory, and binary files', async () => {
        const ws = await createWorkspace();
        try {
            await writeFile(join(ws.dir, 'empty.txt'), '');
            await writeFile(join(ws.dir, 'bin.dat'), Buffer.from([1, 2, 0, 3]));
            await mkdir(join(ws.dir, 'dir'));
            const { context } = createContext(ws.dir);
            assert.deepEqual(await readTool.execute({ path: 'empty.txt' }, context), {
                content: `${join(ws.dir, 'empty.txt')} is empty.`,
                isError: false,
                files: [await versionOf(join(ws.dir, 'empty.txt'))],
            });
            assert.deepEqual(await readTool.execute({ path: 'nope.txt' }, context), {
                content: `File not found: ${join(ws.dir, 'nope.txt')}`,
                isError: true,
            });
            assert.deepEqual(await readTool.execute({ path: 'dir' }, context), {
                content: `${join(ws.dir, 'dir')} is a directory, not a file. Use Glob to list its files.`,
                isError: true,
            });
            assert.deepEqual(await readTool.execute({ path: 'bin.dat' }, context), {
                content: `${join(ws.dir, 'bin.dat')} looks like a binary file (4 bytes); refusing to read it as text.`,
                isError: true,
            });
        } finally {
            await ws.cleanup();
        }
    });

    it('reads absolute paths outside the workspace', async () => {
        const ws = await createWorkspace();
        const other = await createWorkspace();
        try {
            await writeFile(join(other.dir, 'o.txt'), 'outside');
            const { context } = createContext(ws.dir);
            assert.deepEqual(await readTool.execute({ path: join(other.dir, 'o.txt') }, context), {
                content: '     1\toutside\n[End of file: 1 lines in total.]',
                files: [await versionOf(join(other.dir, 'o.txt'))],
            });
        } finally {
            await ws.cleanup();
            await other.cleanup();
        }
    });

    it('rejects when already aborted', async () => {
        const ws = await createWorkspace();
        try {
            await writeFile(join(ws.dir, 'a.txt'), 'x\n');
            const controller = new AbortController();
            controller.abort();
            const { context } = createContext(ws.dir, controller.signal);
            await assert.rejects(readTool.execute({ path: 'a.txt' }, context));
        } finally {
            await ws.cleanup();
        }
    });
});
