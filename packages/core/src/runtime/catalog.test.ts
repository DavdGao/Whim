import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { Catalog, mergePatch } from './catalog.js';
import { CredentialService, CredentialValidationError } from './credentials.js';
import { PluginHost } from './plugin-host.js';
import { Store } from './store.js';

let dir: string;
before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'whim-catalog-'));
});
after(async () => {
    await rm(dir, { recursive: true, force: true });
});

const seed = {
    id: 'fixture/model',
    revision: 1,
    kind: 'chat',
    adapter: 'fixture-plugin#chat',
    model: 'model',
    name: 'Fixture',
    contextWindow: 1000,
    maxOutputTokens: 100,
    input: { 'text/plain': {} },
    output: ['text/plain'],
    thinking: { levels: ['off', 'high'], default: 'high' },
    options: { style: 'plain' },
};

/**
 * Write a minimal plugin package to disk.
 * @param root Parent directory.
 * @param hostSource Source of the host entry.
 * @returns The package directory.
 */
async function writePlugin(root: string, hostSource: string): Promise<string> {
    const pkg = join(root, 'fixture-plugin');
    await mkdir(join(pkg, 'cards'), { recursive: true });
    await writeFile(
        join(pkg, 'package.json'),
        JSON.stringify({
            name: 'fixture-plugin',
            version: '1.0.0',
            type: 'module',
            whim: { host: './host.js', cards: './cards' },
        })
    );
    await writeFile(join(pkg, 'host.js'), hostSource);
    await writeFile(join(pkg, 'cards', 'model.json'), JSON.stringify(seed));
    await writeFile(join(pkg, 'cards', 'broken.json'), '{ not json');
    return pkg;
}

const hostSource = `
export default {
    activate(context) {
        context.credentials.registerType({
            id: 'fixture-plugin#key',
            schema: {
                type: 'object',
                required: ['apiKey'],
                properties: {
                    apiKey: { type: 'string', writeOnly: true, format: 'password', minLength: 1 },
                    baseUrl: { type: 'string', format: 'uri' },
                },
                additionalProperties: false,
            },
        });
        context.models.registerAdapter({
            id: 'fixture-plugin#chat',
            kind: 'chat',
            credentialTypes: ['fixture-plugin#key'],
            optionsSchema: { type: 'object', properties: { style: { enum: ['plain', 'fancy'] } }, additionalProperties: false },
            validateCard: card => (card.model === 'forbidden' ? [{ path: 'model', message: 'Forbidden model.' }] : []),
            open() { throw new Error('not used'); },
        });
    },
};`;

describe('mergePatch', () => {
    it('follows RFC 7386', () => {
        assert.deepEqual(
            mergePatch(
                { a: 1, b: { c: 2, d: 3 }, e: [1] },
                { a: null, b: { c: 4 }, e: [2], f: 'x' }
            ),
            {
                b: { c: 4, d: 3 },
                e: [2],
                f: 'x',
            }
        );
    });
});

describe('PluginHost, Catalog, and CredentialService', () => {
    it('loads seeds, applies user patches, and reports invalid cards without failing', async () => {
        const root = join(dir, 'layers');
        const pkg = await writePlugin(root, hostSource);
        const store = await Store.open(join(root, 'db.sqlite'));
        const host = new PluginHost(store, [{ dir: pkg, source: 'bundled' }]);
        await host.start();
        assert.deepEqual(
            host.statuses().map(status => [status.id, status.availability]),
            [['fixture-plugin', 'active']]
        );
        const userDir = join(root, 'models');
        await mkdir(userDir, { recursive: true });
        await writeFile(
            join(userDir, 'patch.json'),
            JSON.stringify({ id: 'fixture/model', name: 'Renamed', thinking: null })
        );
        await writeFile(
            join(userDir, 'mine.json'),
            JSON.stringify({
                ...seed,
                id: 'user/model',
                model: 'forbidden',
                options: { style: 'loud' },
            })
        );
        const catalog = new Catalog(host, userDir);
        await catalog.start();
        catalog.stop();
        const patched = catalog.card('fixture/model');
        assert.equal(patched?.name, 'Renamed');
        assert.equal(patched?.thinking, undefined);
        const mine = catalog.entries().find(entry => entry.id === 'user/model');
        assert.equal(mine?.card, undefined);
        assert.deepEqual(mine?.issues.length, 2);
        assert.ok(
            catalog
                .entries()
                .some(entry => entry.files[0].endsWith('broken.json') && entry.issues.length === 1)
        );
        await store.close();
    });

    it('stores secrets encrypted and keeps them on partial updates', async () => {
        const root = join(dir, 'credentials');
        const pkg = await writePlugin(root, hostSource);
        const store = await Store.open(join(root, 'db.sqlite'));
        const host = new PluginHost(store, [{ dir: pkg, source: 'bundled' }]);
        await host.start();
        const cipher = {
            encrypt: async (text: string) => new Uint8Array(Buffer.from(text).reverse()),
            decrypt: async (bytes: Uint8Array<ArrayBuffer>) =>
                Buffer.from(bytes).reverse().toString(),
        };
        const service = new CredentialService(store, host, cipher);
        await assert.rejects(
            service.save({ typeId: 'fixture-plugin#key', label: 'Key', values: {} }),
            CredentialValidationError
        );
        const id = await service.save({
            typeId: 'fixture-plugin#key',
            label: 'Key',
            values: { apiKey: 'sk-1' },
        });
        await service.save({
            id,
            typeId: 'fixture-plugin#key',
            label: 'Work',
            values: { baseUrl: 'https://example.com/v1' },
        });
        assert.deepEqual(await service.list(), [
            {
                id,
                typeId: 'fixture-plugin#key',
                label: 'Work',
                values: { baseUrl: 'https://example.com/v1' },
                secretsSet: ['apiKey'],
                createdAt: (await service.list())[0].createdAt,
                available: true,
            },
        ]);
        assert.deepEqual((await service.resolve(id)).values, {
            baseUrl: 'https://example.com/v1',
            apiKey: 'sk-1',
        });
        assert.notDeepEqual(Buffer.from((await store.secrets(id)).apiKey).toString(), 'sk-1');
        await store.close();
    });

    it('rolls back a plugin whose activation fails', async () => {
        const root = join(dir, 'failing');
        const pkg = await writePlugin(
            root,
            `export default { activate(context) {
                context.credentials.registerType({ id: 'fixture-plugin#key', schema: { type: 'object' } });
                throw new Error('boom');
            } };`
        );
        const store = await Store.open(join(root, 'db.sqlite'));
        const host = new PluginHost(store, [{ dir: pkg, source: 'bundled' }]);
        await host.start();
        assert.deepEqual(
            host.statuses().map(status => [status.availability, status.error]),
            [['failed', 'boom']]
        );
        assert.equal(host.credentialTypes.size, 0);
        await store.close();
    });
});
