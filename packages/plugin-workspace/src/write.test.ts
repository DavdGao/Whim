import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createContext, createWorkspace } from './testing.js';
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
            const { context } = createContext(ws.dir);
            const file = join(ws.dir, 'sub', 'a.txt');
            assert.deepEqual(
                await writeTool.execute({ path: 'sub/a.txt', content: 'hello' }, context),
                { content: `Created ${file} (5 bytes).` }
            );
            assert.deepEqual(
                await writeTool.execute({ path: 'sub/a.txt', content: 'bye!' }, context),
                { content: `Overwrote ${file} (4 bytes).` }
            );
            assert.equal(await readFile(file, 'utf8'), 'bye!');
            assert.deepEqual(await readdir(join(ws.dir, 'sub')), ['a.txt']);
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
