import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { Terminals } from './terminals.js';
import { TerminalError, Tmux, parseSessions, shellQuote } from './tmux.js';

import type { TerminalEvent } from './terminals.js';

// Runs the real tmux against a private server: TMUX_TMPDIR moves the default socket.
let dir: string;
const previous = process.env.TMUX_TMPDIR;
before(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'whim-tmux-')));
    process.env.TMUX_TMPDIR = dir;
});
after(async () => {
    const tmux = new Tmux({ kind: 'local' }, dir);
    const inventory = await tmux.list(AbortSignal.timeout(5000));
    if (inventory.status === 'ok')
        for (const session of inventory.sessions)
            await tmux.kill(session.key, AbortSignal.timeout(5000));
    if (previous === undefined) delete process.env.TMUX_TMPDIR;
    else process.env.TMUX_TMPDIR = previous;
    await rm(dir, { recursive: true, force: true });
});

/**
 * Wait until a condition holds.
 * @param check The condition.
 * @param ms Timeout.
 */
async function until(check: () => boolean, ms = 5000): Promise<void> {
    const end = Date.now() + ms;
    while (!check()) {
        if (Date.now() > end) throw new Error('Timed out.');
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}

describe('shellQuote and parseSessions', () => {
    it('quotes words for a POSIX shell', () => {
        assert.equal(shellQuote('claude'), 'claude');
        assert.equal(shellQuote('/a/b-c'), '/a/b-c');
        assert.equal(shellQuote(';'), "';'");
        assert.equal(shellQuote("it's here"), `'it'\\''s here'`);
    });

    it('parses list-sessions output, keeping tabs in names', () => {
        assert.deepEqual(
            parseSessions(
                '41\t$2\t1700000000\t1\tp#claude\t/w\tclaude\tmy\tname\n41\t$0\t1600000000\t0\t\t/h\tzsh\tplain\n'
            ),
            [
                {
                    key: '41:$0:1600000000',
                    id: '$0',
                    name: 'plain',
                    createdAt: '2020-09-13T12:26:40.000Z',
                    attachedClients: 0,
                    folder: '/h',
                    command: 'zsh',
                },
                {
                    key: '41:$2:1700000000',
                    id: '$2',
                    name: 'my\tname',
                    createdAt: '2023-11-14T22:13:20.000Z',
                    attachedClients: 1,
                    folder: '/w',
                    command: 'claude',
                    agentId: 'p#claude',
                },
            ]
        );
    });
});

describe('Tmux on this machine', () => {
    it('lists no sessions without a server', async () => {
        const tmux = new Tmux({ kind: 'local' }, dir);
        assert.deepEqual(await tmux.list(AbortSignal.timeout(5000)), {
            status: 'ok',
            sessions: [],
        });
    });

    it('refuses folders that do not exist instead of starting in home', async () => {
        const tmux = new Tmux({ kind: 'local' }, dir);
        const signal = AbortSignal.timeout(5000);
        assert.equal(await tmux.resolveFolder(dir, signal), dir);
        await assert.rejects(
            tmux.resolveFolder(join(dir, 'missing'), signal),
            (error: unknown) => error instanceof TerminalError && error.code === 'not-found'
        );
        await assert.rejects(
            tmux.resolveFolder('relative/path', signal),
            (error: unknown) => error instanceof TerminalError && error.code === 'invalid'
        );
    });

    it('starts a tagged session, attaches without restarting it, detaches, and ends it', async () => {
        const tmux = new Tmux({ kind: 'local' }, dir);
        const signal = AbortSignal.timeout(10_000);
        const session = await tmux.create(
            {
                name: 'whim-test',
                folder: dir,
                agentId: 'p#echo',
                command: ['printf', '%s\\n', 'agent started'],
            },
            signal
        );
        assert.deepEqual(
            { name: session.name, agentId: session.agentId, folder: session.folder },
            { name: 'whim-test', agentId: 'p#echo', folder: dir }
        );

        const events: TerminalEvent[] = [];
        const terminals = new Terminals(event => events.push(event));
        const owner = new AbortController();
        const output = () =>
            events.map(event => (event.type === 'output' ? event.data : '')).join('');
        const terminalId = terminals.open(
            await tmux.attachInvocation(session.key, signal),
            { cols: 100, rows: 30 },
            owner.signal
        );
        // The command typed at start ran once; attaching shows its screen.
        await until(() => output().includes('agent started'));
        terminals.write(terminalId, 'echo typed-$((40+2))\r');
        await until(() => output().includes('typed-42'));
        const attached = await tmux.list(signal);
        assert.equal(
            attached.status === 'ok' ? attached.sessions[0]?.attachedClients : undefined,
            1
        );

        // Closing the window's scope detaches; the session survives.
        owner.abort();
        await until(() => events.some(event => event.type === 'exit'));
        const detached = await tmux.list(signal);
        assert.deepEqual(
            detached.status === 'ok'
                ? detached.sessions.map(item => [item.key, item.attachedClients])
                : [],
            [[session.key, 0]]
        );
        assert.throws(() => terminals.write(terminalId, 'x'), TerminalError);

        await tmux.kill(session.key, signal);
        assert.deepEqual(await tmux.list(signal), { status: 'ok', sessions: [] });
        await assert.rejects(
            tmux.kill(session.key, signal),
            (error: unknown) => error instanceof TerminalError && error.code === 'not-found'
        );
    });

    it('rejects SSH destinations that could be options or shell syntax', () => {
        for (const destination of ['-oProxyCommand=x', 'a b', 'host;rm', ''])
            assert.throws(() => new Tmux({ kind: 'ssh', destination }, dir), TerminalError);
        assert.doesNotThrow(() => new Tmux({ kind: 'ssh', destination: 'me@dev-box.lan' }, dir));
    });
});
