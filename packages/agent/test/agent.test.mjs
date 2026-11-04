import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { foldRecords } from '@whimkit/core';
import { SqliteStore } from '@whimkit/core/runtime';

import { card } from '../../../test/card.mjs';
import { Agent } from '../dist/index.js';

async function fixture(t, generate) {
    const directory = await mkdtemp(join(tmpdir(), 'whim-agent-'));
    const store = await SqliteStore.open(join(directory, 'journal.sqlite'));
    t.after(async () => {
        await store.close();
        await rm(directory, { recursive: true, force: true });
    });
    const command = value =>
        store.execute({ sessionId: 'session', operationId: randomUUID(), ...value });
    await command({
        type: 'create',
        epoch: { id: 'epoch', system: 'Stable system prefix.', card },
    });
    const enqueue = (text, source = 'user') =>
        command({
            type: 'enqueue',
            delivery: {
                id: randomUUID(),
                source,
                placement: 'next-reasoning',
                entry: {
                    id: randomUUID(),
                    role: 'user',
                    origin: source === 'user' ? 'user' : 'host',
                    blocks: [{ type: 'text', text }],
                },
            },
        });
    const agent = new Agent(store, { card, generate, estimateTokens: async () => 20 });
    return { store, command, enqueue, agent };
}

test('chunks are durable before publication and EOF is not a successful completion', async t => {
    const { store, enqueue, agent } = await fixture(t, async function* () {
        yield { type: 'text', text: 'An incomplete sentence' };
    });
    await enqueue('Hello');
    const events = [];
    await assert.rejects(async () => {
        for await (const record of agent.run('session')) {
            events.push(record.fact.type);
            if (record.fact.type === 'output.chunk') {
                assert.deepEqual((await store.read('session')).at(-1), record);
            }
        }
    }, /without a completion event/);
    const view = foldRecords(await store.read('session'));
    assert.deepEqual(events, [
        'run.started',
        'reasoning.prepared',
        'attempt.started',
        'output.chunk',
    ]);
    assert.deepEqual(
        view.messages.slice(-2).map(message => [message.origin, message.blocks]),
        [
            ['assistant', [{ type: 'text', text: 'An incomplete sentence' }]],
            [
                'host',
                [
                    {
                        type: 'text',
                        text: '<system-reminder>The previous response stopped (model-error). Its saved text is incomplete.</system-reminder>',
                    },
                ],
            ],
        ]
    );
    assert.equal(view.run, null);
    assert.deepEqual(
        [...view.attempts.values()].map(attempt => [attempt.outcome, attempt.usage]),
        [['failed', {}]]
    );
});

test('interrupt preserves the exact answer, holds background delivery, and resumes before new input', async t => {
    const requests = [];
    let calls = 0;
    const { store, enqueue, agent } = await fixture(t, async function* (request, signal) {
        requests.push(request);
        if (calls++ === 0) {
            yield { type: 'text', text: 'My final sentence was this.' };
            await setTimeout(10000, undefined, { signal });
            yield { type: 'text', text: 'This must never appear.' };
        } else {
            yield { type: 'text', text: 'My final sentence was this.' };
            yield { type: 'completed', usage: { inputTokens: 50, outputTokens: 8 } };
        }
    });
    await enqueue('Speak');
    const stream = agent.run('session');
    for await (const record of stream) {
        if (record.fact.type === 'output.chunk') {
            await agent.interrupt('session');
            break;
        }
    }
    await enqueue('A file changed.', 'source-change');
    assert.equal(foldRecords(await store.read('session')).held, true);
    await enqueue('What was your last sentence?');
    for await (const record of agent.run('session')) assert.equal(record.sessionId, 'session');
    assert.deepEqual(
        requests[1].messages.map(message => [message.origin, message.blocks[0].text]),
        [
            ['user', 'Speak'],
            ['assistant', 'My final sentence was this.'],
            ['host', '<system-reminder>The user interrupted you.</system-reminder>'],
            ['host', 'A file changed.'],
            ['user', 'What was your last sentence?'],
        ]
    );
    assert.deepEqual(
        requests.map(request => request.system),
        ['Stable system prefix.', 'Stable system prefix.']
    );
    assert.deepEqual(
        [...foldRecords(await store.read('session')).attempts.values()].map(attempt => [
            attempt.outcome,
            attempt.usage,
        ]),
        [
            ['interrupted', {}],
            ['completed', { inputTokens: 50, outputTokens: 8 }],
        ]
    );
});

test(
    'abort while awaiting provider output terminates without waiting for its natural EOF',
    { timeout: 5000 },
    async t => {
        const controller = new globalThis.AbortController();
        const { store, enqueue, agent } = await fixture(t, async function* (_request, signal) {
            yield { type: 'text', text: 'Saved' };
            controller.abort();
            await setTimeout(10000, undefined, { signal });
        });
        await enqueue('Hello');
        const events = [];
        for await (const record of agent.run('session', { signal: controller.signal }))
            events.push(record.fact.type);
        assert.equal(events.at(-1), 'run.interrupted');
        assert.equal(
            foldRecords(await store.read('session')).messages.at(-2).blocks[0].text,
            'Saved'
        );
    }
);

test('consumer disposal seals the draft and frees session ownership', async t => {
    const { store, enqueue, agent } = await fixture(t, async function* () {
        yield { type: 'text', text: 'Visible' };
        yield { type: 'completed', usage: {} };
    });
    await enqueue('Hello');
    for await (const record of agent.run('session')) {
        if (record.fact.type === 'output.chunk') break;
    }
    const view = foldRecords(await store.read('session'));
    assert.deepEqual(
        { run: view.run, held: view.held, outcome: [...view.attempts.values()][0].outcome },
        { run: null, held: true, outcome: 'interrupted' }
    );
});

test('new source notifications append on the next reasoning without changing an in-flight plan', async t => {
    let calls = 0;
    const requests = [];
    const { store, enqueue, agent } = await fixture(t, async function* (request) {
        requests.push(request);
        yield { type: 'text', text: `Answer ${++calls}` };
        yield { type: 'completed', usage: {} };
        assert.fail('The runtime must stop reading after completion.');
    });
    await enqueue('Initial input');
    for await (const record of agent.run('session')) {
        if (record.fact.type === 'output.chunk' && calls === 1)
            await enqueue(
                '<system-notification>Skill changed.</system-notification>',
                'source-change'
            );
    }
    assert.equal(calls, 2);
    assert.deepEqual(
        requests[1].messages.slice(0, requests[0].messages.length),
        requests[0].messages
    );
    assert.equal(requests[1].messages.at(-1).origin, 'host');
    assert.equal(requests[1].system, requests[0].system);
    assert.equal(
        [...foldRecords(await store.read('session')).inbox.values()].filter(
            item => !item.consumedBy
        ).length,
        0
    );
});

test('successful compaction changes the epoch atomically while retaining tasks, tail, and original records', async t => {
    const { store, command, enqueue, agent } = await fixture(t, async function* (request) {
        yield {
            type: 'text',
            text: request.purpose === 'compaction' ? 'A compact summary.' : 'A full answer.',
        };
        yield { type: 'completed', usage: { inputTokens: 10, outputTokens: 5 } };
    });
    await command({
        type: 'task',
        task: { id: 'task', title: 'Keep this task', status: 'pending' },
        expectedRevision: null,
    });
    await enqueue('Please help');
    for await (const record of agent.run('session')) assert.ok(record.id);
    const beforeRecords = await store.read('session');
    const before = foldRecords(beforeRecords);
    const events = [];
    for await (const record of agent.run('session', {
        compaction: {
            epoch: { ...before.epoch, id: 'next-epoch', system: 'Refreshed snapshot.' },
            retainLast: 1,
        },
    }))
        events.push(record.fact.type);
    const afterRecords = await store.read('session');
    const after = foldRecords(afterRecords);
    assert.deepEqual(afterRecords.slice(0, beforeRecords.length), beforeRecords);
    assert.deepEqual(after.tasks, before.tasks);
    assert.deepEqual(after.messages.slice(1), before.messages.slice(-1));
    assert.equal(
        after.messages[0].blocks[0].text,
        '<context-summary>\nA compact summary.\n</context-summary>'
    );
    assert.equal(after.epoch.system, 'Refreshed snapshot.');
    assert.ok(events.includes('compaction.started'));
    assert.ok(events.includes('compaction.finished'));
    assert.equal(after.attempts.size, 2);
});

test('failed compaction cannot replace the epoch or prior context', async t => {
    const { store, enqueue, agent } = await fixture(t, async function* (request) {
        if (request.purpose === 'compaction') {
            yield { type: 'text', text: 'Incomplete summary' };
            return;
        }
        yield { type: 'text', text: 'Complete response' };
        yield { type: 'completed', usage: {} };
    });
    await enqueue('Hello');
    for await (const record of agent.run('session')) assert.ok(record.id);
    const before = foldRecords(await store.read('session'));
    await assert.rejects(async () => {
        for await (const record of agent.run('session', {
            compaction: { epoch: { ...before.epoch, id: 'next' }, retainLast: 0 },
        }))
            assert.ok(record.id);
    }, /without a completion event/);
    const after = foldRecords(await store.read('session'));
    assert.deepEqual(
        { epoch: after.epoch, messages: after.messages, tasks: after.tasks },
        { epoch: before.epoch, messages: before.messages, tasks: before.tasks }
    );
    assert.equal(after.run, null);
});

test('compaction cannot remove the verbatim interrupted answer before its next reasoning', async t => {
    const { store, command, enqueue, agent } = await fixture(t, async function* (request) {
        yield {
            type: 'text',
            text: request.purpose === 'compaction' ? 'Summary' : 'Preserve this exact sentence.',
        };
        yield { type: 'completed', usage: {} };
    });
    await enqueue('Hello');
    for await (const record of agent.run('session')) {
        if (record.fact.type === 'output.chunk') {
            await agent.interrupt('session');
            break;
        }
    }
    await command({ type: 'resume' });
    const before = foldRecords(await store.read('session'));
    await assert.rejects(async () => {
        for await (const record of agent.run('session', {
            compaction: { epoch: { ...before.epoch, id: 'next' }, retainLast: 0 },
        }))
            assert.ok(record.id);
    }, /preserve the current tail/);
    assert.deepEqual(foldRecords(await store.read('session')).messages, before.messages);
    for await (const record of agent.run('session', {
        compaction: { epoch: { ...before.epoch, id: 'next' }, retainLast: 2 },
    }))
        assert.ok(record.id);
    assert.deepEqual(
        foldRecords(await store.read('session')).messages.slice(1),
        before.messages.slice(-2)
    );
});

test('unknown or exceeded model limits refuse dispatch without consuming the inbox', async t => {
    const { store, enqueue } = await fixture(t, async function* () {
        assert.fail('Unused fixture');
    });
    await enqueue('Still pending');
    const agent = new Agent(store, {
        card,
        estimateTokens: async () => 16000,
        async *generate() {
            assert.fail('An oversized request must not be dispatched');
        },
    });
    await assert.rejects(
        async () => {
            for await (const record of agent.run('session')) assert.ok(record.id);
        },
        { message: 'context-limit' }
    );
    const view = foldRecords(await store.read('session'));
    assert.deepEqual(
        {
            messages: view.messages,
            attempts: [...view.attempts],
            consumed: [...view.inbox.values()].map(item => item.consumedBy),
            run: view.run,
        },
        { messages: [], attempts: [], consumed: [null], run: null }
    );
});

test('a completed summary cannot install an oversized replacement epoch', async t => {
    const { store, enqueue, agent } = await fixture(t, async function* () {
        yield { type: 'text', text: 'Summary or response.' };
        yield { type: 'completed', usage: { inputTokens: 20, outputTokens: 4 } };
    });
    await enqueue('Hello');
    for await (const record of agent.run('session')) assert.ok(record.id);
    const before = foldRecords(await store.read('session'));
    await assert.rejects(async () => {
        for await (const record of agent.run('session', {
            compaction: {
                epoch: { ...before.epoch, id: 'next', system: 'x'.repeat(100001) },
                retainLast: 0,
            },
        }))
            assert.ok(record.id);
    }, /byte budget/);
    const after = foldRecords(await store.read('session'));
    assert.deepEqual(
        { epoch: after.epoch, messages: after.messages },
        { epoch: before.epoch, messages: before.messages }
    );
    assert.deepEqual(
        [...after.attempts.values()].map(attempt => [attempt.outcome, attempt.usage]),
        [
            ['completed', { inputTokens: 20, outputTokens: 4 }],
            ['completed', { inputTokens: 20, outputTokens: 4 }],
        ]
    );
});
