import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
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
            epoch: { epochId: randomUUID(), system: 'system', card, renderer: 1 },
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
});
