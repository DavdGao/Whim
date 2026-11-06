import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { Catalog, mergePatch } from './catalog.js';
import { CredentialService, CredentialValidationError } from './credentials.js';
import { PluginHost, apiIncompatibility } from './plugin-host.js';
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
 * @param extra Additional `whim` manifest fields.
 * @returns The package directory.
 */
async function writePlugin(
    root: string,
    hostSource: string,
    extra: Record<string, unknown> = {}
): Promise<string> {
    const pkg = join(root, 'fixture-plugin');
    await mkdir(join(pkg, 'cards'), { recursive: true });
    await writeFile(
        join(pkg, 'package.json'),
        JSON.stringify({
            name: 'fixture-plugin',
            version: '1.0.0',
            type: 'module',
            whim: {
                api: '1.0',
                host: './host.js',
                contributes: { credentialTypes: ['key'], adapters: ['chat', 'decide'] },
                cards: './cards',
                ...extra,
            },
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
        context.models.registerAdapter({
            id: 'fixture-plugin#decide',
            kind: 'decision',
            credentialTypes: ['fixture-plugin#key'],
            optionsSchema: { type: 'object', additionalProperties: false },
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
        const patched = catalog.chatCard('fixture/model');
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

    it('validates Decision cards against an adapter of their kind', async () => {
        const root = join(dir, 'decision');
        const pkg = await writePlugin(root, hostSource);
        const store = await Store.open(join(root, 'db.sqlite'));
        const host = new PluginHost(store, [{ dir: pkg, source: 'bundled' }]);
        await host.start();
        const userDir = join(root, 'models');
        await mkdir(userDir, { recursive: true });
        const decision = {
            id: 'user/judge',
            revision: 1,
            kind: 'decision',
            adapter: 'fixture-plugin#decide',
            model: 'judge',
            name: 'Judge',
        };
        await writeFile(join(userDir, 'judge.json'), JSON.stringify(decision));
        await writeFile(
            join(userDir, 'wrong.json'),
            JSON.stringify({ ...decision, id: 'user/wrong', adapter: 'fixture-plugin#chat' })
        );
        const catalog = new Catalog(host, userDir);
        await catalog.start();
        catalog.stop();
        assert.deepEqual(catalog.decisionCard('user/judge'), { ...decision, options: {} });
        assert.equal(catalog.chatCard('user/judge'), undefined);
        assert.equal(catalog.decisionCard('fixture/model'), undefined);
        assert.deepEqual(catalog.entries().find(entry => entry.id === 'user/wrong')?.issues, [
            'Adapter fixture-plugin#chat serves chat models.',
        ]);
        await host.stop();
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

    it('loads plugin icons as data URLs and skips invalid ones', async () => {
        const root = join(dir, 'icons');
        const pkg = await writePlugin(root, hostSource, {
            icon: './logo.svg',
            icons: {
                model: './model.png',
                outside: '../outside.svg',
                script: './host.js',
                large: './large.svg',
            },
        });
        await writeFile(join(pkg, 'logo.svg'), '<svg/>');
        await writeFile(join(pkg, 'model.png'), Buffer.from([1, 2, 3]));
        await writeFile(join(root, 'outside.svg'), '<svg/>');
        await writeFile(join(pkg, 'large.svg'), 'x'.repeat(64 * 1024 + 1));
        const store = await Store.open(join(root, 'db.sqlite'));
        const host = new PluginHost(store, [{ dir: pkg, source: 'bundled' }]);
        await host.start();
        const [status] = host.statuses();
        assert.equal(status?.icon, `data:image/svg+xml;base64,${btoa('<svg/>')}`);
        assert.deepEqual(status?.icons, { model: 'data:image/png;base64,AQID' });
        await host.stop();
        await store.close();
    });

    it('refuses plugins built for another plugin API version', async () => {
        assert.equal(apiIncompatibility('1.0'), undefined);
        assert.equal(apiIncompatibility('1.9'), 'Requires plugin API 1.9; this Whim provides 1.0.');
        assert.equal(apiIncompatibility('2.0'), 'Requires plugin API 2.0; this Whim provides 1.0.');
        const root = join(dir, 'api');
        const pkg = await writePlugin(root, hostSource, { api: '2.0' });
        const store = await Store.open(join(root, 'db.sqlite'));
        const host = new PluginHost(store, [{ dir: pkg, source: 'bundled' }]);
        await host.start();
        assert.deepEqual(
            host.statuses().map(status => [status.availability, status.error]),
            [['failed', 'Requires plugin API 2.0; this Whim provides 1.0.']]
        );
        assert.equal(host.adapters.size, 0);
        await store.close();
    });

    it('fails a plugin that registers something it did not declare', async () => {
        const root = join(dir, 'undeclared');
        const pkg = await writePlugin(root, hostSource, {
            contributes: { credentialTypes: ['key'], adapters: ['chat'] },
        });
        const store = await Store.open(join(root, 'db.sqlite'));
        const host = new PluginHost(store, [{ dir: pkg, source: 'bundled' }]);
        await host.start();
        assert.deepEqual(
            host.statuses().map(status => [status.availability, status.error, status.contributes]),
            [
                [
                    'failed',
                    'decide is not declared in whim.contributes.adapters.',
                    { credentialTypes: ['key'], adapters: ['chat'], tools: [] },
                ],
            ]
        );
        assert.equal(host.credentialTypes.size, 0);
        assert.equal(host.adapters.size, 0);
        await store.close();
    });
});
