import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createContext, createWorkspace } from './testing.js';
import { versionOf } from './versions.js';
import { writeTool } from './write.js';

describe('Write', () => {
    it('declares write access', () => {
        assert.deepEqual(writeTool.access({ path: 'x/y.txt', content: '' }, { workspace: '/w' }), [
            { kind: 'write', path: '/w/x/y.txt' },
        ]);
        assert.deepEqual(writeTool.access({ path: '/t/y.txt', content: '' }, { workspace: '/w' }), [
            { kind: 'write', path: '/t/y.txt' },
        ]);
    });

    it('creates then overwrites atomically', async () => {
        const ws = await createWorkspace();
        try {
            const known = new Map();
            const { context } = createContext(ws.dir, undefined, known);
            const file = join(ws.dir, 'sub', 'a.txt');
            const created = await writeTool.execute(
                { path: 'sub/a.txt', content: 'hello' },
                context
            );
            assert.deepEqual(created, {
                content: `Created ${file} (5 bytes).`,
                files: [await versionOf(file)],
            });
            // The runtime records the written version, so overwriting it needs no Read.
            for (const version of created.files ?? []) known.set(version.path, version);
            assert.deepEqual(
                await writeTool.execute({ path: 'sub/a.txt', content: 'bye!' }, context),
                { content: `Overwrote ${file} (4 bytes).`, files: [await versionOf(file)] }
            );
            assert.equal(await readFile(file, 'utf8'), 'bye!');
            assert.deepEqual(await readdir(join(ws.dir, 'sub')), ['a.txt']);
        } finally {
            await ws.cleanup();
        }
    });

    it('refuses to overwrite a file that was not read', async () => {
        const ws = await createWorkspace();
        try {
            const file = join(ws.dir, 'a.txt');
            await writeTool.execute(
                { path: 'a.txt', content: 'mine' },
                createContext(ws.dir).context
            );
            assert.deepEqual(
                await writeTool.execute(
                    { path: 'a.txt', content: 'x' },
                    createContext(ws.dir).context
                ),
                {
                    content: `Read ${file} before changing it, so the change is based on its current content.`,
                    isError: true,
                }
            );
            assert.equal(await readFile(file, 'utf8'), 'mine');
        } finally {
            await ws.cleanup();
        }
    });

    it('fails without a workspace for relative paths', async () => {
        const { context } = createContext(undefined);
        await assert.rejects(
            writeTool.execute({ path: 'a.txt', content: '' }, context),
            /no workspace/
        );
    });
});
