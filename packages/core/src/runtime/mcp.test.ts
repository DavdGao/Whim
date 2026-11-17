import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { McpHost, mcpToolName, toolOutput } from './mcp.js';

import type { McpServerConfig, McpServerStatus } from '../contracts/mcp.js';
import type { ToolContext } from '../plugin/index.js';

const fixture = fileURLToPath(new URL('./fixtures/mcp-server.js', import.meta.url));

/**
 * A stdio configuration running the fixture server.
 * @param overrides Fields to change.
 * @returns The configuration.
 */
function config(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
    return {
        id: 'fixture',
        label: 'Fixture',
        enabled: true,
        trusted: false,
        transport: { kind: 'stdio', command: process.execPath, args: [fixture], env: {} },
        // "secret: " encrypted by the test cipher below, which only reverses bytes.
        secrets: { FIXTURE_GREETING: Buffer.from(' :terces').toString('base64') },
        ...overrides,
    };
}

const hosts: McpHost[] = [];
after(async () => {
    await Promise.all(hosts.map(host => host.stop()));
});

/**
 * A host whose cipher reverses bytes, and a way to wait for a server's state.
 * @returns The host and the wait.
 */
function host() {
    const waiters: (() => void)[] = [];
    const instance = new McpHost({
        decrypt: async ciphertext => Buffer.from(ciphertext).reverse().toString(),
        client: { name: 'whim-test', version: '0.0.0' },
        onChange: () => waiters.splice(0).forEach(resolve => resolve()),
    });
    hosts.push(instance);
    const until = async (test: (status: McpServerStatus | undefined) => boolean) => {
        const deadline = Date.now() + 15_000;
        while (!test(instance.statuses()[0])) {
            assert.ok(Date.now() < deadline, JSON.stringify(instance.statuses()));
            await new Promise<void>(resolve => {
                waiters.push(resolve);
                setTimeout(resolve, 200);
            });
        }
    };
    return { host: instance, until };
}

const context = { signal: new AbortController().signal } as ToolContext;

describe('McpHost', () => {
    it('stops a process while its initial handshake is still pending', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'whim-mcp-start-'));
        const pidFile = join(directory, 'pid');
        const { host: instance } = host();
        try {
            await instance.configure([
                config({
                    transport: {
                        kind: 'stdio',
                        command: process.execPath,
                        args: [
                            '-e',
                            "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)",
                            pidFile,
                        ],
                        env: {},
                        startupTimeoutMs: 600000,
                    },
                }),
            ]);
            let pid = 0;
            for (let attempt = 0; attempt < 100; attempt++) {
                try {
                    pid = Number(await readFile(pidFile, 'utf8'));
                    break;
                } catch (error) {
                    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
                        throw error;
                    await delay(20);
                }
            }
            assert.ok(pid > 0);
            await instance.stop();
            assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
        } finally {
            await instance.stop();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('connects a stdio server and offers its tools under the server id', async () => {
        const { host: instance, until } = host();
        await instance.configure([config()]);
        await until(status => status?.state === 'ready');
        assert.deepEqual(instance.statuses(), [
            {
                id: 'fixture',
                label: 'Fixture',
                state: 'ready',
                tools: ['mcp__fixture__echo', 'mcp__fixture__pixel', 'mcp__fixture__fail'],
                skipped: 0,
            },
        ]);
        const echo = instance.tool('mcp__fixture__echo');
        assert.ok(echo);
        assert.equal(echo.readOnly, true);
        assert.equal(echo.description, 'Repeat a text.\n\n(A tool of the MCP server "Fixture".)');
        // Untrusted: every call asks, per tool.
        assert.deepEqual(echo.access({}, {}), [{ kind: 'mcp', server: 'fixture', tool: 'echo' }]);
        // The secret reached the server's environment.
        assert.deepEqual(await echo.execute({ text: 'hi' }, context), { content: 'secret: hi' });
        assert.deepEqual(await instance.tool('mcp__fixture__pixel')?.execute({}, context), {
            content: '',
            media: [{ mediaType: 'image/png', data: Buffer.from([1]) }],
        });
        assert.deepEqual(await instance.tool('mcp__fixture__fail')?.execute({}, context), {
            content: 'it broke',
            isError: true,
        });

        // Trusting it changes later calls without reconnecting; disabling stops it.
        await instance.configure([config({ trusted: true })]);
        await until(status => status?.state === 'ready');
        assert.deepEqual(instance.tool('mcp__fixture__echo')?.access({}, {}), []);
        await instance.configure([config({ enabled: false })]);
        assert.deepEqual(instance.statuses(), [
            { id: 'fixture', label: 'Fixture', state: 'disabled' },
        ]);
        assert.deepEqual(instance.tools(), []);
    });

    it('reports a server that cannot start and retries later', async () => {
        const { host: instance, until } = host();
        await instance.configure([
            config({
                transport: {
                    kind: 'stdio',
                    command: '/nonexistent/whim-mcp',
                    args: [],
                    env: {},
                },
            }),
        ]);
        await until(status => status?.state === 'failed');
        const status = instance.statuses()[0];
        assert.equal(status?.state, 'failed');
        assert.ok(status.state === 'failed' && status.retryAt);
        assert.deepEqual(instance.tools(), []);
        assert.deepEqual(await instance.call('fixture', 'echo', {}, context.signal), {
            content: 'The MCP server fixture is not connected.',
            isError: true,
        });
    });

    it('names tools only when the name is valid and short enough', () => {
        assert.equal(mcpToolName('gh', 'search_repos'), 'mcp__gh__search_repos');
        assert.equal(mcpToolName('gh', 'has space'), undefined);
        assert.equal(mcpToolName('gh', 'x'.repeat(60)), undefined);
    });

    it('turns resources and structured results into text', () => {
        assert.deepEqual(
            toolOutput({
                content: [
                    { type: 'resource_link', uri: 'file:///a.txt', name: 'a' },
                    { type: 'resource', resource: { uri: 'file:///b.txt', text: 'b' } },
                ],
            }),
            {
                content:
                    '<resource uri="file:///a.txt" name="a"/>\n<resource uri="file:///b.txt">\nb\n</resource>',
            }
        );
        assert.deepEqual(toolOutput({ content: [], structuredContent: { n: 1 } }), {
            content: '{"n":1}',
        });
    });
});
