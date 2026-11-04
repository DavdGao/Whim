import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { transform } from 'esbuild';

const source = await readFile(new URL('../src/renderer/catalog.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const { en, zh } = await import(
    `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
);

test('English and Chinese catalogs have identical nonempty keys', () => {
    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
    assert.ok(Object.values(zh).every(value => value.length));
});
