import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { PluginCallError, PluginHost } from './plugin-host.js';
import { Store } from './store.js';

import type { TopicValue } from './plugin-host.js';

let dir: string;
before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'whim-plugin-host-'));
});
after(async () => {
    await rm(dir, { recursive: true, force: true });
});

/**
 * Write a plugin package and open a host over it.
 * @param name Test directory name.
 * @param hostSource Source of the host entry.
 * @param contributes The manifest's `whim.contributes`.
 * @returns The started host and its store.
 */
async function start(
    name: string,
    hostSource: string,
    contributes: Record<string, string[]>
): Promise<{ host: PluginHost; store: Store }> {
    const root = join(dir, name);
    const pkg = join(root, 'rpc-plugin');
    await mkdir(pkg, { recursive: true });
    await writeFile(
        join(pkg, 'package.json'),
        JSON.stringify({
            name: 'rpc-plugin',
            version: '1.0.0',
            type: 'module',
            whim: { api: '1.0', host: './host.js', contributes },
        })
    );
    await writeFile(join(pkg, 'host.js'), hostSource);
    const store = await Store.open(join(root, 'db.sqlite'));
    const host = new PluginHost(store, [{ dir: pkg, source: 'bundled' }]);
    await host.start();
    return { host, store };
}

const rpcSource = `
export default {
    activate(context) {
        const count = context.rpc.topic({
            name: 'count',
            schema: { type: 'integer', minimum: 0 },
            initial: 0,
        });
        context.rpc.method({
            name: 'add',
            inputSchema: {
                type: 'object',
                required: ['by'],
                properties: { by: { type: 'integer' } },
                additionalProperties: false,
            },
            outputSchema: { type: 'integer' },
            handle(input) {
                globalThis.rpcTotal = (globalThis.rpcTotal ?? 0) + input.by;
                count.publish(globalThis.rpcTotal);
                return globalThis.rpcTotal;
            },
        });
        context.rpc.method({
            name: 'broken',
            inputSchema: { type: 'object' },
            outputSchema: { type: 'string' },
            handle: () => 42,
        });
        context.services.register({
            id: 'ticker',
            start: signal =>
                new Promise(resolve => {
                    globalThis.tickerRunning = true;
                    signal.addEventListener('abort', () => {
                        globalThis.tickerRunning = false;
                        resolve();
                    });
                }),
        });
    },
};`;

describe('PluginHost services, methods, and topics', () => {
    it('validates calls, publishes topics, and stops services with the plugin', async () => {
        const { host, store } = await start('rpc', rpcSource, {
            methods: ['add', 'broken'],
            topics: ['count'],
            services: ['ticker'],
        });
        assert.deepEqual(
            host.statuses().map(status => status.availability),
            ['active']
        );
        assert.equal((globalThis as { tickerRunning?: boolean }).tickerRunning, true);
        assert.deepEqual(host.topicValues(), [
            { pluginId: 'rpc-plugin', name: 'count', seq: 0, value: 0 },
        ]);
        const published: TopicValue[] = [];
        host.onTopic(topic => published.push(topic));
        const signal = new AbortController().signal;
        assert.equal(await host.callMethod('rpc-plugin', 'add', { by: 2 }, signal), 2);
        assert.deepEqual(published, [{ pluginId: 'rpc-plugin', name: 'count', seq: 1, value: 2 }]);
        await assert.rejects(
            host.callMethod('rpc-plugin', 'add', { by: 'x' }, signal),
            (error: unknown) =>
                error instanceof PluginCallError &&
                error.code === 'invalid' &&
                error.issues[0]?.path === '/by'
        );
        await assert.rejects(
            host.callMethod('rpc-plugin', 'missing', {}, signal),
            (error: unknown) => error instanceof PluginCallError && error.code === 'not-found'
        );
        await assert.rejects(
            host.callMethod('rpc-plugin', 'broken', {}, signal),
            /returned invalid output from broken/
        );
        await host.stop();
        assert.equal((globalThis as { tickerRunning?: boolean }).tickerRunning, false);
        assert.deepEqual(host.topicValues(), []);
        await assert.rejects(
            host.callMethod('rpc-plugin', 'add', { by: 1 }, signal),
            (error: unknown) => error instanceof PluginCallError && error.code === 'not-found'
        );
        await store.close();
    });

    it('fails a plugin whose service or method is not declared', async () => {
        const { host, store } = await start('undeclared', rpcSource, {
            methods: ['add', 'broken'],
            topics: ['count'],
        });
        assert.deepEqual(
            host.statuses().map(status => [status.availability, status.error]),
            [['failed', 'ticker is not declared in whim.contributes.services.']]
        );
        assert.deepEqual(host.topicValues(), []);
        await store.close();
    });

    it('reports a service that fails on its own while the plugin stays active', async () => {
        const { host, store } = await start(
            'failing-service',
            `export default {
                activate(context) {
                    context.services.register({
                        id: 'sync',
                        start: async () => { throw new Error('connection refused'); },
                    });
                },
            };`,
            { services: ['sync'] }
        );
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.deepEqual(
            host.statuses().map(status => [status.availability, status.error]),
            [['active', 'Service sync stopped: connection refused']]
        );
        await host.stop();
        await store.close();
    });

    it('registers declared coding agents and removes them when the plugin stops', async () => {
        const { host, store } = await start(
            'coding',
            `export default {
                activate(context) {
                    context.coding.registerAgent({
                        id: context.pluginId + '#claude',
                        name: 'agent.name',
                        command: ['claude', '--verbose'],
                    });
                },
            };`,
            { codingAgents: ['claude'] }
        );
        assert.deepEqual(
            [...host.codingAgents.values()],
            [
                {
                    pluginId: 'rpc-plugin',
                    agent: {
                        id: 'rpc-plugin#claude',
                        name: 'agent.name',
                        command: ['claude', '--verbose'],
                    },
                },
            ]
        );
        await host.stop();
        assert.deepEqual([...host.codingAgents.values()], []);
        await store.close();
    });

    it('fails a plugin whose coding agent is undeclared or has no command', async () => {
        for (const [name, agent, error] of [
            [
                'coding-undeclared',
                `{ id: context.pluginId + '#codex', name: 'n', command: ['codex'] }`,
                'codex is not declared in whim.contributes.codingAgents.',
            ],
            [
                'coding-empty',
                `{ id: context.pluginId + '#claude', name: 'n', command: [] }`,
                'Coding agent rpc-plugin#claude needs a command.',
            ],
        ] as const) {
            const { host, store } = await start(
                name,
                `export default { activate(context) { context.coding.registerAgent(${agent}); } };`,
                { codingAgents: ['claude'] }
            );
            assert.deepEqual(
                host.statuses().map(status => [status.availability, status.error]),
                [['failed', error]]
            );
            assert.deepEqual([...host.codingAgents.values()], []);
            await store.close();
        }
    });

    it('loads valid themes and skips invalid ones', async () => {
        const root = join(dir, 'themes');
        const pkg = join(root, 'theme-plugin');
        await mkdir(join(pkg, 'themes'), { recursive: true });
        await writeFile(
            join(pkg, 'package.json'),
            JSON.stringify({
                name: 'theme-plugin',
                version: '1.0.0',
                type: 'module',
                whim: {
                    api: '1.0',
                    host: './host.js',
                    themes: [
                        './themes/sunset.json',
                        './themes/unknown-token.json',
                        './themes/remote.json',
                        './themes/outside.json',
                    ],
                },
            })
        );
        await writeFile(join(pkg, 'host.js'), 'export default { activate() {} };');
        await writeFile(join(pkg, 'themes', 'sunset.png'), Buffer.from([1, 2, 3]));
        await writeFile(
            join(pkg, 'themes', 'sunset.json'),
            JSON.stringify({
                id: 'sunset',
                name: 'theme.sunset',
                light: { primary: 'oklch(0.65 0.2 30)', radius: '1.25rem' },
                backgroundImage: './sunset.png',
            })
        );
        await writeFile(
            join(pkg, 'themes', 'unknown-token.json'),
            JSON.stringify({ id: 'odd', name: 'odd', light: { 'font-family': 'serif' } })
        );
        await writeFile(
            join(pkg, 'themes', 'remote.json'),
            JSON.stringify({
                id: 'remote',
                name: 'remote',
                light: { background: 'url(https://example.com/a.png)' },
            })
        );
        await writeFile(
            join(pkg, 'themes', 'outside.json'),
            JSON.stringify({
                id: 'outside',
                name: 'outside',
                light: {},
                backgroundImage: '../../outside.png',
            })
        );
        const store = await Store.open(join(root, 'db.sqlite'));
        const host = new PluginHost(store, [{ dir: pkg, source: 'bundled' }]);
        await host.start();
        assert.deepEqual(host.statuses()[0]?.themes, [
            {
                id: 'sunset',
                name: 'theme.sunset',
                light: { primary: 'oklch(0.65 0.2 30)', radius: '1.25rem' },
                image: { path: join(pkg, 'themes', 'sunset.png'), mediaType: 'image/png' },
            },
        ]);
        await host.stop();
        await store.close();
    });
});
