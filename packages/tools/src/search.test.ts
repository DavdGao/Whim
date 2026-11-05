import assert from 'node:assert/strict';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { createContext, createWorkspace } from './testing.js';

/**
 * Create a small tree: tracked sources, an ignored dir, a hidden file, and .git content.
 * @param dir Workspace root.
 */
async function populate(dir: string): Promise<void> {
    await mkdir(join(dir, 'src'), { recursive: true });
    await mkdir(join(dir, 'build'));
    await mkdir(join(dir, '.git'));
    await writeFile(join(dir, '.gitignore'), 'build/\n');
    await writeFile(join(dir, 'src', 'old.ts'), 'export const alpha = 1;\nconst Beta = 2;\n');
    await writeFile(join(dir, 'src', 'new.ts'), 'export const gamma = 3;\n');
    await writeFile(join(dir, 'src', 'notes.md'), 'alpha notes\n');
    await writeFile(join(dir, 'build', 'out.ts'), 'export const alpha = 9;\n');
    await writeFile(join(dir, '.hidden.ts'), 'hidden alpha\n');
    await writeFile(join(dir, '.git', 'config.ts'), 'alpha in git\n');
    await utimes(join(dir, 'src', 'old.ts'), new Date(1_000_000), new Date(1_000_000));
    await utimes(join(dir, 'src', 'notes.md'), new Date(2_000_000), new Date(2_000_000));
    await utimes(join(dir, '.hidden.ts'), new Date(3_000_000), new Date(3_000_000));
}

describe('Glob', () => {
    it('declares read access of the search root', () => {
        assert.deepEqual(globTool.access({ pattern: '*' }, { workspace: '/w' }), [
            { kind: 'read', path: '/w' },
        ]);
        assert.deepEqual(globTool.access({ pattern: '*', path: 'src' }, { workspace: '/w' }), [
            { kind: 'read', path: '/w/src' },
        ]);
        assert.deepEqual(globTool.access({ pattern: '*', path: '/x/y' }, { workspace: '/w' }), [
            { kind: 'read', path: '/x/y' },
        ]);
    });

    it('sorts newest first, honors gitignore, includes hidden files, skips .git', async () => {
        const ws = await createWorkspace();
        try {
            await populate(ws.dir);
            const { context } = createContext(ws.dir);
            const result = await globTool.execute({ pattern: '**/*.ts' }, context);
            // new.ts has the current time; the others have fixed older times.
            assert.deepEqual(result, { content: 'src/new.ts\n.hidden.ts\nsrc/old.ts' });
        } finally {
            await ws.cleanup();
        }
    });

    it('searches a subdirectory and reports no matches', async () => {
        const ws = await createWorkspace();
        try {
            await populate(ws.dir);
            const { context } = createContext(ws.dir);
            assert.deepEqual(await globTool.execute({ pattern: '*.md', path: 'src' }, context), {
                content: 'notes.md',
            });
            assert.deepEqual(await globTool.execute({ pattern: '*.rs' }, context), {
                content: `No files match "*.rs" in ${ws.dir}.`,
            });
            assert.deepEqual(await globTool.execute({ pattern: '*', path: 'missing' }, context), {
                content: `Directory not found: ${join(ws.dir, 'missing')}`,
                isError: true,
            });
        } finally {
            await ws.cleanup();
        }
    });

    it('caps results at 200 with a note', async () => {
        const ws = await createWorkspace();
        try {
            for (let i = 0; i < 205; i += 1) {
                await writeFile(join(ws.dir, `f${String(i).padStart(3, '0')}.txt`), '');
            }
            const { context } = createContext(ws.dir);
            const result = await globTool.execute({ pattern: '*.txt' }, context);
            const lines = result.content.split('\n');
            assert.equal(lines.length, 201);
            assert.equal(
                lines[200],
                '[Showing the 200 newest of 205 matches; more results exist. Narrow the pattern or path.]'
            );
        } finally {
            await ws.cleanup();
        }
    });
});

describe('Grep', () => {
    it('declares read access of the search root', () => {
        assert.deepEqual(grepTool.access({ pattern: 'x' }, { workspace: '/w' }), [
            { kind: 'read', path: '/w' },
        ]);
        assert.deepEqual(grepTool.access({ pattern: 'x', path: '/o/f.txt' }, { workspace: '/w' }), [
            { kind: 'read', path: '/o/f.txt' },
        ]);
    });

    it('lists matching files by default, respecting gitignore and skipping .git', async () => {
        const ws = await createWorkspace();
        try {
            await populate(ws.dir);
            const { context } = createContext(ws.dir);
            assert.deepEqual(await grepTool.execute({ pattern: 'alpha' }, context), {
                content: '.hidden.ts\nsrc/notes.md\nsrc/old.ts',
            });
        } finally {
            await ws.cleanup();
        }
    });

    it('shows content with line numbers, context, case folding, glob and type filters', async () => {
        const ws = await createWorkspace();
        try {
            await populate(ws.dir);
            const { context } = createContext(ws.dir);
            assert.deepEqual(
                await grepTool.execute(
                    { pattern: 'beta', '-i': true, output_mode: 'content', glob: 'src/**' },
                    context
                ),
                { content: 'src/old.ts:2:const Beta = 2;' }
            );
            assert.deepEqual(
                await grepTool.execute(
                    { pattern: 'Beta', output_mode: 'content', '-B': 1, type: 'ts' },
                    context
                ),
                { content: 'src/old.ts-1-export const alpha = 1;\nsrc/old.ts:2:const Beta = 2;' }
            );
            assert.deepEqual(
                await grepTool.execute(
                    { pattern: 'Beta', output_mode: 'content', '-n': false },
                    context
                ),
                { content: 'src/old.ts:const Beta = 2;' }
            );
        } finally {
            await ws.cleanup();
        }
    });

    it('counts matches and searches a single file', async () => {
        const ws = await createWorkspace();
        try {
            await populate(ws.dir);
            const { context } = createContext(ws.dir);
            assert.deepEqual(
                await grepTool.execute({ pattern: 'const', output_mode: 'count' }, context),
                {
                    content: 'src/new.ts:1\nsrc/old.ts:2',
                }
            );
            assert.deepEqual(
                await grepTool.execute(
                    { pattern: 'const', path: 'src/old.ts', output_mode: 'content' },
                    context
                ),
                { content: 'old.ts:1:export const alpha = 1;\nold.ts:2:const Beta = 2;' }
            );
        } finally {
            await ws.cleanup();
        }
    });

    it('supports multiline patterns', async () => {
        const ws = await createWorkspace();
        try {
            await populate(ws.dir);
            const { context } = createContext(ws.dir);
            assert.deepEqual(
                await grepTool.execute({ pattern: 'alpha = 1;\\nconst', multiline: true }, context),
                { content: 'src/old.ts' }
            );
            const single = await grepTool.execute({ pattern: 'alpha = 1;\\nconst' }, context);
            assert.equal(single.isError, true);
            assert.match(single.content, /Consider enabling multiline mode/);
        } finally {
            await ws.cleanup();
        }
    });

    it('treats no match as a normal result and a bad regex as an error', async () => {
        const ws = await createWorkspace();
        try {
            await populate(ws.dir);
            const { context } = createContext(ws.dir);
            assert.deepEqual(await grepTool.execute({ pattern: 'zzz-none' }, context), {
                content: `No matches for "zzz-none" in ${ws.dir}.`,
            });
            const bad = await grepTool.execute({ pattern: '(' }, context);
            assert.equal(bad.isError, true);
            assert.match(bad.content, /^ripgrep failed: .*regex parse error/s);
        } finally {
            await ws.cleanup();
        }
    });

    it('caps output at head_limit and says so', async () => {
        const ws = await createWorkspace();
        try {
            await writeFile(join(ws.dir, 'many.txt'), 'hit\n'.repeat(10));
            const { context } = createContext(ws.dir);
            const result = await grepTool.execute(
                { pattern: 'hit', output_mode: 'content', head_limit: 3 },
                context
            );
            assert.deepEqual(result, {
                content:
                    'many.txt:1:hit\nmany.txt:2:hit\nmany.txt:3:hit\n[Output capped at 3 lines; more results exist. Narrow the search or raise head_limit.]',
            });
        } finally {
            await ws.cleanup();
        }
    });

    it('does not treat a pattern starting with a dash as a flag', async () => {
        const ws = await createWorkspace();
        try {
            await writeFile(join(ws.dir, 'a.txt'), '--flag\n');
            const { context } = createContext(ws.dir);
            assert.deepEqual(await grepTool.execute({ pattern: '--flag' }, context), {
                content: 'a.txt',
            });
        } finally {
            await ws.cleanup();
        }
    });

    it('rejects when already aborted', async () => {
        const ws = await createWorkspace();
        try {
            const controller = new AbortController();
            controller.abort();
            const { context } = createContext(ws.dir, controller.signal);
            await assert.rejects(grepTool.execute({ pattern: 'x' }, context));
        } finally {
            await ws.cleanup();
        }
    });
});
