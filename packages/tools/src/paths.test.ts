import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { resolve, writeFileAtomic } from './paths.js';
import { createWorkspace } from './testing.js';

describe('resolve', () => {
    it('keeps absolute paths and normalizes them', () => {
        assert.equal(resolve({ workspace: '/w' }, '/a/b/../c'), '/a/c');
        assert.equal(resolve({}, '/a/c'), '/a/c');
    });

    it('resolves relative paths against the workspace', () => {
        assert.equal(resolve({ workspace: '/w' }, 'src/../x.ts'), '/w/x.ts');
        assert.equal(resolve({ workspace: '/w' }, '.'), '/w');
    });

    it('throws for relative paths without a workspace', () => {
        assert.throws(() => resolve({}, 'x.ts'), /no workspace/);
    });
});

describe('writeFileAtomic', () => {
    it('creates parents, reports created, then overwritten, and leaves no temp files', async () => {
        const ws = await createWorkspace();
        try {
            const file = join(ws.dir, 'a', 'b', 'c.txt');
            assert.deepEqual(await writeFileAtomic(file, 'héllo'), { created: true, bytes: 6 });
            assert.deepEqual(await writeFileAtomic(file, 'x'), { created: false, bytes: 1 });
            assert.equal(await readFile(file, 'utf8'), 'x');
            assert.deepEqual(await readdir(join(ws.dir, 'a', 'b')), ['c.txt']);
        } finally {
            await ws.cleanup();
        }
    });

    it('keeps the mode of an existing file', async () => {
        const ws = await createWorkspace();
        try {
            const file = join(ws.dir, 'run.sh');
            await writeFile(file, 'old');
            await chmod(file, 0o755);
            await writeFileAtomic(file, 'new');
            assert.equal((await stat(file)).mode & 0o777, 0o755);
        } finally {
            await ws.cleanup();
        }
    });

    it('rejects a directory target and cleans up', async () => {
        const ws = await createWorkspace();
        try {
            await mkdir(join(ws.dir, 'd'));
            await assert.rejects(writeFileAtomic(join(ws.dir, 'd'), 'x'), /is a directory/);
            assert.deepEqual(await readdir(ws.dir), ['d']);
        } finally {
            await ws.cleanup();
        }
    });
});
