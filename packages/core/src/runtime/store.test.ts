import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';

import { Store } from './store.js';

import type { Command } from './commands.js';
import type { FrozenChatCard } from '../contracts/card.js';

const card: FrozenChatCard = {
    id: 'test/model',
    revision: 1,
    adapter: 'test#chat',
    model: 'model',
    name: 'Model',
    contextWindow: 1000,
    maxOutputTokens: 100,
    input: { 'text/plain': {} },
    output: ['text/plain'],
    nativeTools: [],
    options: {},
};

let dir: string;
before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'whim-store-'));
});
after(async () => {
    await rm(dir, { recursive: true, force: true });
});

/**
 * Build a command with fresh session and operation ids.
 * @param sessionId The session.
 * @param command The command without ids.
 * @returns The complete command.
 */
function cmd(sessionId: string, command: Record<string, unknown>): Command {
    return { sessionId, operationId: randomUUID(), ...command } as Command;
}

/**
 * Create a session with one initial epoch.
 * @param store The store.
 * @returns The new session id.
 */
async function createSession(store: Store): Promise<string> {
    const sessionId = randomUUID();
    await store.execute(
        cmd(sessionId, {
            type: 'create',
            title: 'Chat',
            credentialId: 'cred',
            epoch: {
                epochId: randomUUID(),
                system: 'system',
                card,
                renderer: 1,
                tools: [],
                nativeTools: [],
            },
        })
    );
    return sessionId;
}

/**
 * Accept one user message.
 * @param store The store.
 * @param sessionId The session.
 * @param text The message text.
 * @returns The delivery id.
 */
async function send(store: Store, sessionId: string, text: string): Promise<string> {
    const deliveryId = randomUUID();
    await store.execute(
        cmd(sessionId, {
            type: 'send',
            deliveryId,
            placement: 'next-step',
            item: {
                type: 'message',
                id: randomUUID(),
                role: 'user',
                blocks: [{ type: 'text', text }],
            },
        })
    );
    return deliveryId;
}

describe('Store', () => {
    it('recovers compaction after killing its process and rejects late results', async t => {
        const path = join(dir, 'compaction-crash.sqlite');
        const fixture = join(dir, 'compaction-crash.mjs');
        await writeFile(
            fixture,
            `
            import { Store } from ${JSON.stringify(new URL('./store.js', import.meta.url).href)};
            const store = await Store.open(${JSON.stringify(path)});
            await store.execute({
                type: 'create', sessionId: 'session', operationId: 'create',
                title: 'Chat', credentialId: 'cred',
                epoch: { epochId: 'epoch', system: 'system', card: ${JSON.stringify(card)},
                    renderer: 1, tools: [], nativeTools: [] }
            });
            await store.execute({ type: 'start-run', sessionId: 'session', operationId: 'run',
                runId: 'run', trigger: 'user' });
            await store.execute({ type: 'start-compaction', sessionId: 'session', operationId: 'compact',
                runId: 'run', compactionId: 'compact' });
            await store.execute({ type: 'record-compaction-attempt', sessionId: 'session', operationId: 'attempt',
                compactionId: 'compact', usage: { inputTokens: 10, outputTokens: 2 } });
            process.send('ready');
        `
        );
        const child = spawn(process.execPath, [fixture], {
            stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        });
        t.after(() => {
            child.kill('SIGKILL');
        });
        assert.deepEqual(await once(child, 'message', { signal: AbortSignal.timeout(10_000) }), [
            'ready',
            undefined,
        ]);
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        assert.deepEqual(await exited, [null, 'SIGKILL']);

        const store = await Store.open(path);
        t.after(() => store.close());
        const before = await store.view('session');
        assert.deepEqual(
            (await store.recoverySessions()).map(item => item.sessionId),
            ['session']
        );
        const records = await store.execute(
            cmd('session', {
                type: 'recover',
                reason: 'crash',
                observedAt: '2026-11-17T09:12:22.000Z',
            })
        );
        assert.deepEqual(
            records
                .filter(record => record.body.type === 'compaction.finished')
                .map(record => record.body),
            [
                {
                    type: 'compaction.finished',
                    compactionId: 'compact',
                    outcome: 'failed',
                    failure: {
                        category: 'cancelled',
                        retry: { kind: 'never' },
                        outcome: 'unknown',
                        detail: {
                            provider: 'whim',
                            message: 'Compaction was interrupted before it completed.',
                        },
                    },
                },
            ]
        );
        const view = await store.view('session');
        assert.deepEqual(view.compactions, [{ seq: 4, compactionId: 'compact', state: 'failed' }]);
        assert.deepEqual(view.epoch, before.epoch);
        assert.deepEqual(view.usage, { inputTokens: 10, outputTokens: 2 });
        assert.deepEqual(view.lastRun?.result, { outcome: 'interrupted', reason: 'crash' });
        assert.deepEqual(await store.recoverySessions(), []);
        assert.deepEqual(
            await store.execute(
                cmd('session', {
                    type: 'recover',
                    reason: 'crash',
                    observedAt: '2026-11-17T09:12:23.000Z',
                })
            ),
            []
        );
        await assert.rejects(
            store.execute(
                cmd('session', {
                    type: 'record-compaction-attempt',
                    compactionId: 'compact',
                    usage: { inputTokens: 999 },
                })
            ),
            { code: 'conflict' }
        );
        await assert.rejects(
            store.execute(
                cmd('session', {
                    type: 'finish-compaction',
                    compactionId: 'compact',
                    result: {
                        status: 'succeeded',
                        epoch: {
                            epochId: 'late',
                            system: 'late summary',
                            context: {
                                summary: 'late',
                                from: 3,
                                transcript: 'file:///tmp/history.md',
                            },
                            card,
                            renderer: 1,
                            tools: [],
                            nativeTools: [],
                        },
                    },
                })
            ),
            { code: 'conflict' }
        );
        await store.execute(
            cmd('session', { type: 'start-run', runId: 'next', trigger: 'continue' })
        );
        await store.execute(
            cmd('session', { type: 'start-compaction', runId: 'next', compactionId: 'next' })
        );
        assert.deepEqual((await store.view('session')).compactions, [
            { seq: 4, compactionId: 'compact', state: 'failed' },
            { seq: 10, compactionId: 'next', state: 'running' },
        ]);
    });

    it('closes unfinished compaction atomically when its run ends', async t => {
        const store = await Store.open(join(dir, 'compaction-end.sqlite'));
        t.after(() => store.close());
        const sessionId = await createSession(store);
        const runId = 'run';
        await store.execute(cmd(sessionId, { type: 'start-run', runId, trigger: 'user' }));
        await store.execute(
            cmd(sessionId, { type: 'start-compaction', runId, compactionId: 'compact' })
        );
        const ended = await store.execute(
            cmd(sessionId, {
                type: 'end-run',
                runId,
                result: { outcome: 'interrupted', reason: 'user' },
            })
        );
        assert.deepEqual(
            ended.map(record => record.body),
            [
                {
                    type: 'compaction.finished',
                    compactionId: 'compact',
                    outcome: 'failed',
                    failure: {
                        category: 'cancelled',
                        retry: { kind: 'never' },
                        outcome: 'unknown',
                        detail: {
                            provider: 'whim',
                            message: 'Compaction was interrupted before it completed.',
                        },
                    },
                },
                { type: 'run.ended', runId, result: { outcome: 'interrupted', reason: 'user' } },
            ]
        );
        assert.equal(ended[0].operationId, ended[1].operationId);
        assert.deepEqual(await store.recoverySessions(), []);
    });

    it('upgrades and recovers legacy stranded compaction without rewriting history', async t => {
        const path = join(dir, 'compaction-legacy.sqlite');
        const store = await Store.open(path);
        t.after(() => store.close());
        const sessionId = await createSession(store);
        await createSession(store);
        await store.execute(cmd(sessionId, { type: 'start-run', runId: 'run', trigger: 'user' }));
        await store.execute(
            cmd(sessionId, { type: 'start-compaction', runId: 'run', compactionId: 'finished' })
        );
        await store.execute(
            cmd(sessionId, {
                type: 'finish-compaction',
                compactionId: 'finished',
                result: {
                    status: 'succeeded',
                    epoch: {
                        epochId: 'summary',
                        system: 'summarized',
                        context: {
                            summary: 'saved summary',
                            from: 3,
                            transcript: 'file:///tmp/history.md',
                        },
                        card,
                        renderer: 1,
                        tools: [],
                        nativeTools: [],
                    },
                },
            })
        );
        await store.execute(
            cmd(sessionId, { type: 'start-compaction', runId: 'run', compactionId: 'stranded' })
        );
        const before = await store.view(sessionId);
        await store.close();

        // Older recovery ended the run but forgot the compaction, then cleared this projection.
        const raw = new DatabaseSync(path);
        const ended = {
            id: 'legacy-ended',
            sessionId,
            seq: before.head + 1,
            version: 1,
            createdAt: '2026-11-17T09:12:22.000Z',
            operationId: 'legacy-recovery',
            body: {
                type: 'run.ended',
                runId: 'run',
                result: {
                    outcome: 'failed',
                    failure: {
                        category: 'internal',
                        retry: { kind: 'never' },
                        outcome: 'unknown',
                        detail: { provider: 'whim', message: 'A compaction is already running.' },
                    },
                },
            },
        };
        raw.prepare('INSERT INTO journal VALUES (?, ?, ?, ?, ?, ?)').run(
            sessionId,
            ended.seq,
            ended.id,
            ended.body.type,
            1,
            JSON.stringify(ended)
        );
        raw.prepare(
            'UPDATE sessions SET head = ?, running = 0, needs_recovery = 0 WHERE id = ?'
        ).run(ended.seq, sessionId);
        raw.exec('PRAGMA user_version = 3');
        const original = raw
            .prepare('SELECT body FROM journal WHERE session_id = ? ORDER BY seq')
            .all(sessionId);
        raw.close();

        const reopened = await Store.open(path);
        t.after(() => reopened.close());
        assert.deepEqual(
            (await reopened.recoverySessions()).map(item => item.sessionId),
            [sessionId]
        );
        const backups = (await readdir(dir)).filter(
            name => name.startsWith('compaction-legacy.sqlite.v3-') && name.endsWith('.bak')
        );
        assert.equal(backups.length, 1);
        const backup = new DatabaseSync(join(dir, backups[0]), { readOnly: true });
        assert.deepEqual(
            backup
                .prepare('SELECT body FROM journal WHERE session_id = ? ORDER BY seq')
                .all(sessionId),
            original
        );
        backup.close();
        const recovered = await reopened.execute(
            cmd(sessionId, {
                type: 'recover',
                reason: 'crash',
                observedAt: '2026-11-17T10:00:00.000Z',
            })
        );
        assert.deepEqual(
            recovered.map(record => record.body),
            [
                {
                    type: 'compaction.finished',
                    compactionId: 'stranded',
                    outcome: 'failed',
                    failure: {
                        category: 'cancelled',
                        retry: { kind: 'never' },
                        outcome: 'unknown',
                        detail: {
                            provider: 'whim',
                            message: 'Compaction was interrupted before it completed.',
                        },
                    },
                },
            ]
        );
        const view = await reopened.view(sessionId);
        assert.deepEqual(view.compactions, [
            {
                seq: 4,
                compactionId: 'finished',
                state: 'succeeded',
                summary: 'saved summary',
                from: 3,
            },
            { seq: 7, compactionId: 'stranded', state: 'failed' },
        ]);
        assert.deepEqual(view.epoch, before.epoch);
        assert.deepEqual(await reopened.recoverySessions(), []);
        assert.deepEqual(
            (await reopened.read(sessionId)).slice(0, ended.seq).map(record => ({ ...record })),
            original.map(row => JSON.parse(String(row.body)))
        );
        await reopened.execute(
            cmd(sessionId, { type: 'start-run', runId: 'next', trigger: 'continue' })
        );
        await reopened.execute(
            cmd(sessionId, { type: 'start-compaction', runId: 'next', compactionId: 'next' })
        );
    });

    it('persists refreshed tools without changing context and fences unsafe refreshes', async () => {
        const path = join(dir, 'refresh-tools.sqlite');
        let store = await Store.open(path);
        try {
            const sessionId = await createSession(store);
            const context = {
                summary: 'Earlier work',
                from: 3,
                transcript: 'file:///tmp/history.md',
            };
            await store.execute(
                cmd(sessionId, {
                    type: 'switch-model',
                    epoch: {
                        epochId: 'before-refresh',
                        system: 'system',
                        card,
                        renderer: 1,
                        tools: [],
                        nativeTools: ['WebSearch'],
                        providerTools: ['WebFetch'],
                        context,
                    },
                })
            );
            await send(store, sessionId, 'Search notes');
            const runId = 'source-run';
            const stepId = 'source-step';
            const tools = [
                { name: 'SearchNotes', description: 'Search', inputSchema: { type: 'object' } },
            ];
            const refresh = cmd(sessionId, {
                type: 'refresh-tools',
                runId,
                epochId: 'ready',
                tools,
            });
            await assert.rejects(store.execute(refresh), { code: 'conflict' });
            await store.execute(cmd(sessionId, { type: 'start-run', runId, trigger: 'user' }));
            await assert.rejects(store.execute(refresh), { code: 'conflict' });
            await store.execute(cmd(sessionId, { type: 'prepare-step', runId, stepId }));
            const before = await store.view(sessionId);
            const records = await store.execute(refresh);
            assert.deepEqual(
                records.map(record => record.body),
                [
                    {
                        type: 'epoch.started',
                        reason: 'tools-changed',
                        epochId: 'ready',
                        system: 'system',
                        card,
                        renderer: 1,
                        tools,
                        nativeTools: ['WebSearch'],
                        providerTools: ['WebFetch'],
                        context,
                    },
                ]
            );
            const after = await store.view(sessionId);
            assert.deepEqual(after, {
                ...before,
                head: before.head + 1,
                updatedAt: records[0].createdAt,
                epoch: {
                    ...before.epoch,
                    seq: before.head + 1,
                    epochId: 'ready',
                    reason: 'tools-changed',
                    tools,
                },
            });
            assert.deepEqual(await store.execute(refresh), records);
            assert.deepEqual(await store.execute({ ...refresh, operationId: randomUUID() }), []);
            await store.execute(
                cmd(sessionId, { type: 'start-compaction', runId, compactionId: 'summary' })
            );
            await assert.rejects(store.execute({ ...refresh, operationId: randomUUID() }), {
                code: 'conflict',
            });
            await store.execute(
                cmd(sessionId, {
                    type: 'finish-compaction',
                    compactionId: 'summary',
                    result: {
                        status: 'failed',
                        failure: {
                            category: 'cancelled',
                            retry: { kind: 'never' },
                            outcome: 'rejected',
                            detail: { provider: 'test' },
                        },
                    },
                })
            );
            await store.execute(
                cmd(sessionId, {
                    type: 'start-attempt',
                    runId,
                    stepId,
                    attemptId: 'attempt',
                    number: 1,
                })
            );
            await assert.rejects(store.execute({ ...refresh, operationId: randomUUID() }), {
                code: 'conflict',
            });
            await store.execute(
                cmd(sessionId, {
                    type: 'finish-attempt',
                    attemptId: 'attempt',
                    usage: {},
                    result: {
                        status: 'completed',
                        output: {
                            messageId: 'reply',
                            blocks: [
                                {
                                    type: 'tool_call',
                                    callId: 'call',
                                    name: 'SearchNotes',
                                    arguments: '{}',
                                },
                            ],
                        },
                    },
                })
            );
            await assert.rejects(store.execute({ ...refresh, operationId: randomUUID() }), {
                code: 'conflict',
            });
            await store.execute(
                cmd(sessionId, {
                    type: 'interrupt',
                    runId,
                    reason: 'user',
                    observedAt: '2026-11-17T00:00:00.000Z',
                })
            );
            await assert.rejects(store.execute({ ...refresh, operationId: randomUUID() }), {
                code: 'conflict',
            });
            const persisted = await store.view(sessionId);
            await store.close();
            store = await Store.open(path);
            assert.deepEqual(await store.view(sessionId), persisted);
        } finally {
            await store.close();
        }
    });

    it('runs a full turn and rebuilds the same view after reopening', async () => {
        const path = join(dir, 'turn.sqlite');
        const store = await Store.open(path);
        const sessionId = await createSession(store);
        await send(store, sessionId, 'hello');
        const runId = randomUUID();
        const stepId = randomUUID();
        const attemptId = randomUUID();
        await store.execute(cmd(sessionId, { type: 'start-run', runId, trigger: 'user' }));
        const [prepared] = await store.execute(
            cmd(sessionId, { type: 'prepare-step', runId, stepId })
        );
        assert.equal(prepared.body.type, 'step.prepared');
        await store.execute(
            cmd(sessionId, { type: 'start-attempt', runId, stepId, attemptId, number: 1 })
        );
        await store.execute(
            cmd(sessionId, {
                type: 'finish-attempt',
                attemptId,
                usage: { inputTokens: 5, outputTokens: 2 },
                result: {
                    status: 'completed',
                    output: { messageId: 'reply', blocks: [{ type: 'text', text: 'hi' }] },
                },
            })
        );
        await store.execute(
            cmd(sessionId, { type: 'end-run', runId, result: { outcome: 'completed' } })
        );
        const view = await store.view(sessionId);
        assert.equal(view.run, undefined);
        assert.equal(view.inbox.size, 0);
        assert.deepEqual(
            view.history.map(entry => entry.item.type === 'message' && entry.item.blocks),
            [[{ type: 'text', text: 'hello' }], [{ type: 'text', text: 'hi' }]]
        );
        assert.deepEqual(view.usage, { inputTokens: 5, outputTokens: 2 });
        assert.deepEqual(
            (await store.sessions()).map(session => [
                session.sessionId,
                session.running,
                session.head,
            ]),
            [[sessionId, false, view.head]]
        );
        await store.close();

        const reopened = await Store.open(path);
        const rebuilt = await reopened.view(sessionId);
        assert.deepEqual(
            { ...rebuilt, inbox: [...rebuilt.inbox] },
            { ...view, inbox: [...view.inbox] }
        );
        await reopened.close();
    });

    it('returns the original receipt for a repeated operation and rejects changed input', async () => {
        const store = await Store.open(join(dir, 'idempotent.sqlite'));
        const sessionId = await createSession(store);
        const command = cmd(sessionId, { type: 'update', title: 'Renamed' });
        const first = await store.execute(command);
        const second = await store.execute(command);
        assert.deepEqual(second, first);
        await assert.rejects(store.execute({ ...command, title: 'Other' } as Command), {
            code: 'conflict',
        });
        assert.equal((await store.read(sessionId)).length, 3);
        await store.close();
    });

    it('keeps a pending message withdrawable and rejects stale attempts', async () => {
        const store = await Store.open(join(dir, 'withdraw.sqlite'));
        const sessionId = await createSession(store);
        const deliveryId = await send(store, sessionId, 'too big');
        await store.execute(cmd(sessionId, { type: 'withdraw', deliveryId }));
        assert.equal((await store.view(sessionId)).inbox.size, 0);
        await assert.rejects(store.execute(cmd(sessionId, { type: 'withdraw', deliveryId })), {
            code: 'conflict',
        });
        await assert.rejects(
            store.execute(
                cmd(sessionId, {
                    type: 'finish-attempt',
                    attemptId: 'stale',
                    usage: {},
                    result: {
                        status: 'failed',
                        failure: {
                            category: 'internal',
                            retry: { kind: 'never' },
                            outcome: 'unknown',
                        },
                    },
                })
            ),
            { code: 'conflict' }
        );
        await store.close();
    });

    it('recovers an interrupted run with a restarted notice', async () => {
        const store = await Store.open(join(dir, 'recover.sqlite'));
        const sessionId = await createSession(store);
        await send(store, sessionId, 'hello');
        const runId = randomUUID();
        const stepId = randomUUID();
        await store.execute(cmd(sessionId, { type: 'start-run', runId, trigger: 'user' }));
        await store.execute(cmd(sessionId, { type: 'prepare-step', runId, stepId }));
        await store.execute(
            cmd(sessionId, { type: 'start-attempt', runId, stepId, attemptId: 'a1', number: 1 })
        );
        assert.deepEqual(
            (await store.recoverySessions()).map(session => session.sessionId),
            [sessionId]
        );
        await store.execute(
            cmd(sessionId, {
                type: 'recover',
                reason: 'crash',
                observedAt: new Date().toISOString(),
            })
        );
        const view = await store.view(sessionId);
        assert.equal(view.run, undefined);
        assert.deepEqual(view.lastRun?.result, { outcome: 'interrupted', reason: 'crash' });
        assert.deepEqual(
            [...view.inbox.values()].map(
                pending => pending.item.type === 'notice' && pending.item.kind
            ),
            ['restarted']
        );
        assert.deepEqual(await store.recoverySessions(), []);
        await store.close();
    });

    it('isolates an unreadable session', async () => {
        const path = join(dir, 'corrupt.sqlite');
        const store = await Store.open(path);
        const healthy = await createSession(store);
        const broken = await createSession(store);
        await store.close();
        const raw = new DatabaseSync(path);
        raw.prepare("UPDATE journal SET body = '{}' WHERE session_id = ? AND seq = 2").run(broken);
        raw.close();
        const reopened = await Store.open(path);
        await assert.rejects(reopened.view(broken), { code: 'unreadable' });
        assert.equal((await reopened.view(healthy)).sessionId, healthy);
        assert.equal((await reopened.sessions()).length, 2);
        await reopened.close();
    });

    it("moves a database that is not Whim's aside without modifying it", async () => {
        const path = join(dir, 'foreign.sqlite');
        const raw = new DatabaseSync(path);
        raw.exec('CREATE TABLE journal (body TEXT); PRAGMA user_version = 3;');
        raw.prepare('INSERT INTO journal VALUES (?)').run('old');
        raw.close();
        const store = await Store.open(path);
        assert.ok(store.movedAside);
        assert.deepEqual(await store.sessions(), []);
        await createSession(store);
        await store.close();
        const moved = new DatabaseSync(store.movedAside);
        assert.deepEqual(
            moved
                .prepare('SELECT body FROM journal')
                .all()
                .map(row => ({ ...row })),
            [{ body: 'old' }]
        );
        assert.deepEqual({ ...moved.prepare('PRAGMA user_version').get() }, { user_version: 3 });
        moved.close();
        const reopened = await Store.open(path);
        assert.equal(reopened.movedAside, undefined);
        assert.equal((await reopened.sessions()).length, 1);
        await reopened.close();
    });

    it('adopts a schema 1 database created before the application marker', async () => {
        const path = join(dir, 'unmarked.sqlite');
        const store = await Store.open(path);
        const sessionId = await createSession(store);
        await store.close();
        const raw = new DatabaseSync(path);
        // Such a database is at schema 1, before the schedules and sources tables.
        raw.exec(
            'DROP TABLE schedules; DROP TABLE sources; PRAGMA user_version = 1; PRAGMA application_id = 0'
        );
        raw.close();
        const reopened = await Store.open(path);
        try {
            assert.equal(reopened.movedAside, undefined);
            assert.equal((await reopened.view(sessionId)).sessionId, sessionId);
            // Migrated to the current schema.
            assert.deepEqual(await reopened.schedules(), []);
            assert.deepEqual(await reopened.sources(), []);
        } finally {
            await reopened.close();
        }
    });

    it('deletes a session completely but refuses while it runs', async () => {
        const store = await Store.open(join(dir, 'delete.sqlite'));
        const sessionId = await createSession(store);
        await send(store, sessionId, 'hello');
        const runId = randomUUID();
        await store.execute(cmd(sessionId, { type: 'start-run', runId, trigger: 'user' }));
        await assert.rejects(store.deleteSession(sessionId), { code: 'conflict' });
        await store.execute(
            cmd(sessionId, { type: 'end-run', runId, result: { outcome: 'completed' } })
        );
        await store.deleteSession(sessionId);
        assert.deepEqual(await store.sessions(), []);
        await assert.rejects(store.view(sessionId), { code: 'not-found' });
        assert.deepEqual(await store.read(sessionId), []);
        await store.close();
    });

    it('records sources and deletes a source with its session', async () => {
        const store = await Store.open(join(dir, 'sources.sqlite'));
        const sessionId = await createSession(store);
        const row = {
            id: 'arxiv',
            sessionId,
            template: 'arxiv',
            name: 'arXiv',
            createdAt: '2026-11-12T00:00:00.000Z',
        };
        await store.putSource(row);
        assert.deepEqual(await store.sources(), [row]);
        // One session belongs to at most one source.
        await assert.rejects(store.putSource({ ...row, id: 'other' }), /UNIQUE/);
        await store.deleteSource('arxiv');
        assert.deepEqual(await store.sources(), []);
        assert.deepEqual(await store.sessions(), []);
        await store.close();
    });

    it('changes the folder between runs with a notice for the model', async () => {
        const store = await Store.open(join(dir, 'workspace.sqlite'));
        const plain = await createSession(store);
        const change = (sessionId: string, workspace: string) =>
            store.execute(
                cmd(sessionId, {
                    type: 'set-workspace',
                    workspace,
                    deliveryId: 'd1',
                    noticeId: 'n1',
                    observedAt: '2026-11-05T00:00:00.000Z',
                })
            );
        await assert.rejects(change(plain, '/b'), { code: 'conflict' });
        const sessionId = randomUUID();
        await store.execute(
            cmd(sessionId, {
                type: 'create',
                title: 'Chat',
                credentialId: 'cred',
                workspace: '/a',
                epoch: {
                    epochId: randomUUID(),
                    system: 'system',
                    card,
                    renderer: 1,
                    tools: [],
                    nativeTools: [],
                },
            })
        );
        const runId = randomUUID();
        await store.execute(cmd(sessionId, { type: 'start-run', runId, trigger: 'user' }));
        await assert.rejects(change(sessionId, '/b'), { code: 'conflict' });
        await store.execute(
            cmd(sessionId, { type: 'end-run', runId, result: { outcome: 'completed' } })
        );
        assert.deepEqual(
            (await change(sessionId, '/b')).map(record => record.body),
            [
                { type: 'session.updated', workspace: '/b' },
                {
                    type: 'delivery.accepted',
                    deliveryId: 'd1',
                    placement: 'next-step',
                    item: {
                        type: 'notice',
                        id: 'n1',
                        origin: { type: 'user' },
                        observedAt: '2026-11-05T00:00:00.000Z',
                        kind: 'workspace-changed',
                        payload: { from: '/a', to: '/b' },
                    },
                },
            ]
        );
        assert.equal((await store.view(sessionId)).workspace, '/b');
        await store.close();
    });
});
