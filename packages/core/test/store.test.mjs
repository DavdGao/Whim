import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { card } from '../../../test/card.mjs';
import { eligibleDeliveries, foldRecords } from '../dist/index.js';
import { SqliteStore } from '../dist/store.js';

async function fixture(t) {
    const directory = await mkdtemp(join(tmpdir(), 'whim-store-'));
    const path = join(directory, 'journal.sqlite');
    const store = await SqliteStore.open(path);
    t.after(async () => {
        await store.close();
        await rm(directory, { recursive: true, force: true });
    });
    const command = value =>
        store.execute({ sessionId: 'session', operationId: randomUUID(), ...value });
    await command({ type: 'create', epoch: { id: 'epoch', system: 'Frozen instructions', card } });
    return { store, path, command };
}

test('SQLite acceptance is idempotent and conflicting or invalid batches append nothing', async t => {
    const { store, command } = await fixture(t);
    const input = {
        type: 'enqueue',
        operationId: 'operation',
        delivery: {
            id: 'delivery',
            source: 'user',
            placement: 'next-reasoning',
            entry: {
                id: 'entry',
                role: 'user',
                origin: 'user',
                blocks: [{ type: 'text', text: 'Hello' }],
            },
        },
    };
    const first = await command(input);
    assert.deepEqual(await command(input), first);
    await assert.rejects(command({ ...input, delivery: { ...input.delivery, id: 'changed' } }), {
        code: 'conflict',
    });
    await assert.rejects(command({ ...input, operationId: 'another' }), { code: 'conflict' });
    const view = foldRecords(await store.read('session'));
    assert.deepEqual(
        {
            head: view.head,
            contextVersion: view.contextVersion,
            messages: view.messages,
            inbox: [...view.inbox.values()],
        },
        {
            head: '2',
            contextVersion: '1',
            messages: [],
            inbox: [{ delivery: input.delivery, seq: '2', consumedBy: null }],
        }
    );
    assert.equal((await store.read('session')).length, 2);
});

test('inbox arrival does not invalidate frozen context; consumption and plan are one transaction', async t => {
    const { store, command } = await fixture(t);
    const run = { runId: 'run', generation: 'generation' };
    await command({ type: 'start', ...run });
    await command({
        type: 'enqueue',
        delivery: {
            id: 'later',
            source: 'runtime',
            placement: 'next-run',
            entry: {
                id: 'later-entry',
                role: 'user',
                origin: 'host',
                blocks: [{ type: 'text', text: 'Later' }],
            },
        },
    });
    await command({
        type: 'enqueue',
        delivery: {
            id: 'now',
            source: 'user',
            placement: 'next-reasoning',
            entry: {
                id: 'now-entry',
                role: 'user',
                origin: 'user',
                blocks: [{ type: 'text', text: 'Now' }],
            },
        },
    });
    await assert.rejects(
        command({
            type: 'prepare',
            ...run,
            planId: 'bad',
            expectedContextVersion: '1',
            deliveryIds: ['later'],
            estimatedTokens: 1,
        }),
        { code: 'conflict' }
    );
    const prepared = await command({
        type: 'prepare',
        ...run,
        planId: 'plan',
        expectedContextVersion: '1',
        deliveryIds: ['now'],
        estimatedTokens: 1,
    });
    const view = foldRecords(await store.read('session'));
    assert.deepEqual(view.messages, [
        { id: 'now-entry', role: 'user', origin: 'user', blocks: [{ type: 'text', text: 'Now' }] },
    ]);
    assert.deepEqual(
        [...view.inbox.values()].map(item => [item.delivery.id, item.consumedBy]),
        [
            ['later', null],
            ['now', 'plan'],
        ]
    );
    assert.deepEqual(view.plans.get('plan'), {
        runId: 'run',
        request: { card, system: 'Frozen instructions', messages: view.messages, purpose: 'chat' },
    });
    assert.deepEqual(eligibleDeliveries(view), []);
    assert.equal(prepared[0].seq, '5');
    await command({
        type: 'attempt',
        ...run,
        planId: 'plan',
        attemptId: 'attempt',
        messageId: 'reply',
        purpose: 'chat',
    });
    await command({
        type: 'finishAttempt',
        ...run,
        attemptId: 'attempt',
        outcome: 'completed',
        usage: {},
    });
    await command({ type: 'end', ...run, outcome: 'completed' });
    await command({ type: 'start', runId: 'next', generation: 'next-generation' });
    assert.deepEqual(
        eligibleDeliveries(foldRecords(await store.read('session'))).map(item => item.id),
        ['later']
    );
});

test('task revisions, interruption cutoff, ownership fencing, and durable replay', async t => {
    const { store, command, path } = await fixture(t);
    const task = { id: 'task', title: 'Finish implementation', status: 'pending' };
    const created = await command({ type: 'task', task, expectedRevision: null });
    await assert.rejects(
        command({ type: 'task', task: { ...task, status: 'completed' }, expectedRevision: null }),
        { code: 'conflict' }
    );
    const run = { runId: 'run', generation: 'generation' };
    await command({ type: 'start', ...run });
    const before = foldRecords(await store.read('session'));
    await command({
        type: 'prepare',
        ...run,
        planId: 'plan',
        expectedContextVersion: before.contextVersion,
        deliveryIds: [...before.inbox.keys()],
        estimatedTokens: 1,
    });
    await command({
        type: 'attempt',
        ...run,
        planId: 'plan',
        attemptId: 'attempt',
        messageId: 'reply',
        purpose: 'chat',
    });
    await command({
        type: 'chunk',
        ...run,
        attemptId: 'attempt',
        index: 0,
        text: 'My last sentence.',
    });
    const interrupted = await command({ type: 'interrupt', ...run, reason: 'user' });
    await assert.rejects(
        command({ type: 'chunk', ...run, attemptId: 'attempt', index: 1, text: 'Late text' }),
        { code: 'stale-run' }
    );
    const second = await SqliteStore.open(path);
    try {
        const view = foldRecords(await second.read('session'));
        assert.deepEqual(view.messages.slice(-2), [
            {
                id: 'reply',
                role: 'assistant',
                origin: 'assistant',
                blocks: [{ type: 'text', text: 'My last sentence.' }],
            },
            {
                id: interrupted[0].id,
                role: 'user',
                origin: 'host',
                blocks: [
                    {
                        type: 'text',
                        text: '<system-reminder>The user interrupted you.</system-reminder>',
                    },
                ],
            },
        ]);
        assert.deepEqual([...view.tasks.values()], [{ task, revision: created[0].id }]);
        assert.deepEqual(
            { held: view.held, run: view.run, usage: view.attempts.get('attempt').usage },
            { held: true, run: null, usage: {} }
        );
        await assert.rejects(command({ type: 'start', runId: 'next', generation: 'next' }), {
            code: 'conflict',
        });
    } finally {
        await second.close();
    }
});

test('two database clients cannot both acquire the session runner', async t => {
    const { store, command, path } = await fixture(t);
    const second = await SqliteStore.open(path);
    try {
        const results = await Promise.allSettled([
            command({ type: 'start', runId: 'one', generation: 'one' }),
            second.execute({
                sessionId: 'session',
                operationId: 'two',
                type: 'start',
                runId: 'two',
                generation: 'two',
            }),
        ]);
        assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected']);
        assert.equal((await store.read('session')).length, 2);
    } finally {
        await second.close();
    }
});

test('a finished generation can never regain authority through a later start', async t => {
    const { command } = await fixture(t);
    await command({ type: 'start', runId: 'run', generation: 'generation' });
    await command({ type: 'end', runId: 'run', generation: 'generation', outcome: 'completed' });
    await assert.rejects(command({ type: 'start', runId: 'another', generation: 'generation' }), {
        code: 'conflict',
    });
    await assert.rejects(command({ type: 'start', runId: 'run', generation: 'another' }), {
        code: 'conflict',
    });
});
