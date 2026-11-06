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
});
