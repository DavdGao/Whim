import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { editTool } from './edit.js';
import { createContext, createWorkspace } from './testing.js';

describe('Edit', () => {
    it('declares write access', () => {
        assert.deepEqual(
            editTool.access({ path: 'a', old_string: 'x', new_string: 'y' }, { workspace: '/w' }),
            [{ kind: 'write', path: '/w/a' }]
        );
    });

    it('replaces a unique match and shows a snippet', async () => {
        const ws = await createWorkspace();
        try {
            const file = join(ws.dir, 'a.txt');
            await writeFile(file, 'l1\nl2\nl3\nl4\nTARGET\nl6\nl7\nl8\nl9\n');
            const { context } = createContext(ws.dir);
            assert.deepEqual(
                await editTool.execute(
                    { path: 'a.txt', old_string: 'TARGET', new_string: 'DONE' },
                    context
                ),
                {
                    content: `Replaced 1 occurrence in ${file}. First change:\n     2\tl2\n     3\tl3\n     4\tl4\n     5\tDONE\n     6\tl6\n     7\tl7\n     8\tl8`,
                }
            );
            assert.equal(await readFile(file, 'utf8'), 'l1\nl2\nl3\nl4\nDONE\nl6\nl7\nl8\nl9\n');
        } finally {
            await ws.cleanup();
        }
    });

    it('reports ambiguous and missing matches without changing the file', async () => {
        const ws = await createWorkspace();
        try {
            const file = join(ws.dir, 'a.txt');
            await writeFile(file, 'foo foo bar');
            const { context } = createContext(ws.dir);
            assert.deepEqual(
                await editTool.execute(
                    { path: 'a.txt', old_string: 'foo', new_string: 'baz' },
                    context
                ),
                {
                    content: `old_string occurs 2 times in ${file}. Add surrounding context to make it unique, or set replace_all to replace every occurrence.`,
                    isError: true,
                }
            );
            assert.deepEqual(
                await editTool.execute(
                    { path: 'a.txt', old_string: 'nope', new_string: 'baz' },
                    context
                ),
                { content: `old_string was not found in ${file}.`, isError: true }
            );
            assert.equal(await readFile(file, 'utf8'), 'foo foo bar');
        } finally {
            await ws.cleanup();
        }
    });

    it('replaces every occurrence with replace_all, treating $ literally', async () => {
        const ws = await createWorkspace();
        try {
            const file = join(ws.dir, 'a.txt');
            await writeFile(file, 'foo foo bar');
            const { context } = createContext(ws.dir);
            const result = await editTool.execute(
                { path: 'a.txt', old_string: 'foo', new_string: '$&', replace_all: true },
                context
            );
            assert.match(result.content, /^Replaced 2 occurrences in /);
            assert.equal(await readFile(file, 'utf8'), '$& $& bar');
        } finally {
            await ws.cleanup();
        }
    });

    it('preserves CRLF line endings exactly', async () => {
        const ws = await createWorkspace();
        try {
            const file = join(ws.dir, 'crlf.txt');
            await writeFile(file, 'a\r\nb\r\nc\r\n');
            const { context } = createContext(ws.dir);
            const result = await editTool.execute(
                { path: 'crlf.txt', old_string: 'b\r\nc', new_string: 'B\r\nC' },
                context
            );
            assert.equal(result.isError, undefined);
            assert.equal(await readFile(file, 'utf8'), 'a\r\nB\r\nC\r\n');
            assert.ok(!result.content.includes('\r'));

            // LF text from the model matches a CRLF file and is written back as CRLF.
            const lf = await editTool.execute(
                { path: 'crlf.txt', old_string: 'B\nC', new_string: 'X\nY' },
                context
            );
            assert.equal(lf.isError, undefined);
            assert.equal(await readFile(file, 'utf8'), 'a\r\nX\r\nY\r\n');
        } finally {
            await ws.cleanup();
        }
    });

    it('rejects empty, identical, and missing-file edits', async () => {
        const ws = await createWorkspace();
        try {
            const { context } = createContext(ws.dir);
            assert.deepEqual(
                await editTool.execute({ path: 'a', old_string: '', new_string: 'x' }, context),
                { content: 'old_string must not be empty.', isError: true }
            );
            assert.deepEqual(
                await editTool.execute({ path: 'a', old_string: 'x', new_string: 'x' }, context),
                {
                    content: 'old_string and new_string are identical; nothing to do.',
                    isError: true,
                }
            );
            assert.deepEqual(
                await editTool.execute({ path: 'a', old_string: 'x', new_string: 'y' }, context),
                { content: `File not found: ${join(ws.dir, 'a')}`, isError: true }
            );
        } finally {
            await ws.cleanup();
        }
    });
});
