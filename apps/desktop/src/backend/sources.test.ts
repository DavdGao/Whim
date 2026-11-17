import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { CredentialService, McpHost, PluginHost, Store } from '@whimkit/core';

import { Sources } from './sources.js';

it("refreshes only a source server's allowed tools after a late MCP connection", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'whim-source-tools-'));
    const store = await Store.open(join(dir, 'db.sqlite'));
    const mcp = new McpHost({
        decrypt: async () => '',
        client: { name: 'whim-test', version: '0.0.0' },
        onChange: () => {},
    });
    try {
        const plugins = new PluginHost(store, []);
        plugins.sources.set('test#source', {
            pluginId: 'test',
            template: {
                id: 'test#source',
                name: 'Source',
                description: 'Source',
                instructions: '',
                tools: [],
                mcpServer: 'fixture',
                mcpTools: ['echo'],
            },
        });
        const sources = new Sources(
            store,
            plugins,
            mcp,
            new CredentialService(store, plugins, {
                encrypt: async text => Buffer.from(text),
                decrypt: async data => Buffer.from(data).toString(),
            }),
            {
                sessionDir: () => dir,
                wake: () => {},
                notify: () => {},
                requesterName: async () => 'User',
            }
        );
        const base = { name: 'Read', description: 'Read a file', inputSchema: { type: 'object' } };
        await store.execute({
            type: 'create',
            operationId: 'create',
            sessionId: 'source',
            title: 'Source',
            credentialId: 'cred',
            epoch: {
                epochId: 'initial',
                system: 'Source',
                renderer: 1,
                tools: [base],
                nativeTools: [],
                providerTools: [],
                card: {
                    id: 'test/model',
                    revision: 1,
                    adapter: 'test#chat',
                    model: 'test',
                    name: 'Test',
                    contextWindow: 10000,
                    maxOutputTokens: 1000,
                    input: { 'text/plain': {} },
                    output: ['text/plain'],
                    nativeTools: [],
                    options: {},
                },
            },
        });
        await sources.add({
            id: 'source',
            sessionId: 'source',
            template: 'test#source',
            name: 'Source',
            createdAt: '2026-11-17T00:00:00.000Z',
        });
        const view = await store.view('source');
        assert.equal(sources.refreshTools(view), undefined);
        const fixture = fileURLToPath(
            new URL('./fixtures/mcp-server.js', import.meta.resolve('@whimkit/core'))
        );
        await mcp.configure(
            ['fixture', 'other'].map(id => ({
                id,
                label: id,
                enabled: true,
                trusted: false,
                transport: {
                    kind: 'stdio' as const,
                    command: process.execPath,
                    args: [fixture],
                    env: {},
                },
                secrets: {},
            }))
        );
        const deadline = Date.now() + 10000;
        while (mcp.statuses().some(status => status.state !== 'ready')) {
            assert.ok(Date.now() < deadline, 'Fixture MCP servers did not connect');
            await delay(20);
        }
        const tools = sources.refreshTools(view);
        assert.deepEqual(tools, [
            base,
            {
                name: 'mcp__fixture__echo',
                description: 'Repeat a text.\n\n(A tool of the MCP server "fixture".)',
                inputSchema: {
                    type: 'object',
                    properties: { text: { type: 'string' } },
                    required: ['text'],
                    $schema: 'http://json-schema.org/draft-07/schema#',
                },
            },
        ]);
        assert.equal(sources.refreshTools({ ...view, sessionId: 'chat' }), undefined);
        assert.ok(tools);
        const refreshed = { ...view, epoch: { ...view.epoch, tools } };
        assert.equal(sources.refreshTools(refreshed), undefined);
        await mcp.configure([]);
        assert.equal(sources.refreshTools(refreshed), undefined);
    } finally {
        await mcp.stop();
        await store.close();
        await rm(dir, { recursive: true, force: true });
    }
});
