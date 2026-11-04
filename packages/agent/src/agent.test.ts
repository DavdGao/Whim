import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { Store } from '@whimkit/core';
import { ApplicationError } from '@whimkit/core/contracts';

import { Agent } from './agent.js';

import type { AgentEvent } from './agent.js';
import type { FrozenChatCard } from '@whimkit/core/contracts';
import type { ChatEvent, ChatRequest, ChatSession } from '@whimkit/core/plugin';

const card: FrozenChatCard = {
    id: 'test/model',
    revision: 1,
    adapter: 'test#chat',
    model: 'model',
    name: 'Model',
    contextWindow: 100_000,
    maxOutputTokens: 100,
    input: { 'text/plain': {} },
    output: ['text/plain'],
    thinking: { levels: ['off', 'high'], default: 'high' },
    nativeTools: [],
    options: {},
};

type Script = (
    request: ChatRequest,
    signal: AbortSignal,
    attempt: number
) => AsyncIterable<ChatEvent>;

/**
 * A model port whose sessions follow a script and record requests.
 * @param script Produces each attempt's events.
 * @param budget Input budget.
 * @returns The port and recorded requests.
 */
function scripted(script: Script, budget = 50_000) {
    const requests: ChatRequest[] = [];
    const session: ChatSession = {
        inputBudget: () => budget,
        stream: (request, signal) => {
            requests.push(request);
            return script(request, signal, requests.length);
        },
    };
    return { models: { open: async () => session }, requests };
}

let dir: string;
let store: Store;
before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'whim-agent-'));
    store = await Store.open(join(dir, 'db.sqlite'));
});
after(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
});

/**
 * Create a session and accept one user message.
 * @param text The message.
 * @returns The session id.
 */
async function sessionWith(text: string): Promise<string> {
    const sessionId = randomUUID();
    await store.execute({
        type: 'create',
        sessionId,
        operationId: randomUUID(),
        title: 'Chat',
        credentialId: 'cred',
        epoch: { epochId: randomUUID(), system: 'Be brief.', card, renderer: 1 },
    });
    await say(sessionId, text);
    return sessionId;
}

/**
 * Accept a user message.
 * @param sessionId The session.
 * @param text The message.
 */
async function say(sessionId: string, text: string): Promise<void> {
    await store.execute({
        type: 'send',
        sessionId,
        operationId: randomUUID(),
        deliveryId: randomUUID(),
        placement: 'next-step',
        item: { type: 'message', id: randomUUID(), role: 'user', blocks: [{ type: 'text', text }] },
    });
}

/**
 * Drain a run.
 * @param events The generator.
 * @returns Its events.
 */
async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
    const all: AgentEvent[] = [];
    for await (const event of events) all.push(event);
    return all;
}

/**
 * Texts of the session history.
 * @param sessionId The session.
 * @returns Role, text, and status per entry.
 */
async function transcript(sessionId: string) {
    const view = await store.view(sessionId);
    return view.history.map(entry =>
        entry.item.type === 'message'
            ? [
                  entry.item.role,
                  entry.item.blocks.map(block => ('text' in block ? block.text : '')).join(''),
                  entry.status ?? '',
              ]
            : ['notice', entry.item.kind, '']
    );
}

const noSleep = async () => {};

describe('Agent', () => {
    it('streams a reply, commits it once, and does not call the model again without input', async () => {
        const { models, requests } = scripted(async function* () {
            yield { type: 'text-delta', text: 'Hi ' };
            yield { type: 'text-delta', text: 'there' };
            yield { type: 'completed', usage: { outputTokens: 2 } };
        });
        const agent = new Agent(store, models, { sleep: noSleep });
        const sessionId = await sessionWith('hello');
        const before = (await store.read(sessionId)).length;
        const events = await drain(agent.run(sessionId, 'user', new AbortController().signal));
        assert.deepEqual(
            events.map(event => event.type === 'stream' && event.text),
            ['Hi ', 'there']
        );
        assert.deepEqual(await transcript(sessionId), [
            ['user', 'hello', ''],
            ['assistant', 'Hi there', 'completed'],
        ]);
        assert.deepEqual(
            (await store.read(sessionId, before)).map(record => record.body.type),
            ['run.started', 'step.prepared', 'attempt.started', 'attempt.finished', 'run.ended']
        );
        assert.deepEqual(requests[0].thinking, 'high');
        await drain(agent.run(sessionId, 'continue', new AbortController().signal));
        assert.equal(requests.length, 1);
    });

    it('records how long the model reasoned before answering', async () => {
        const { models } = scripted(async function* () {
            yield { type: 'reasoning-delta', text: 'Hmm' };
            await new Promise(resolve => setTimeout(resolve, 30));
            yield { type: 'text-delta', text: 'Yes' };
            yield { type: 'completed', usage: {} };
        });
        const agent = new Agent(store, models, { sleep: noSleep });
        const sessionId = await sessionWith('think');
        await drain(agent.run(sessionId, 'user', new AbortController().signal));
        const answer = (await store.view(sessionId)).history.at(-1)?.item;
        assert.ok(answer?.type === 'message');
        const [reasoning, text] = answer.blocks;
        assert.deepEqual(text, { type: 'text', text: 'Yes' });
        assert.ok(reasoning?.type === 'reasoning');
        assert.equal(reasoning.text, 'Hmm');
        assert.ok(
            reasoning.durationMs !== undefined &&
                reasoning.durationMs >= 25 &&
                reasoning.durationMs < 1000
        );
    });

    it('retries after partial output and discards the failed attempt text', async () => {
        const { models, requests } = scripted(async function* (_request, _signal, attempt) {
            yield { type: 'text-delta', text: attempt === 1 ? 'Hal' : 'Hello' };
            if (attempt === 1)
                throw new ApplicationError({
                    category: 'transport',
                    retry: { kind: 'backoff' },
                    outcome: 'partial',
                });
            yield { type: 'completed', usage: {} };
        });
        const sessionId = await sessionWith('hi');
        const events = await drain(
            new Agent(store, models, { sleep: noSleep }).run(
                sessionId,
                'user',
                new AbortController().signal
            )
        );
        assert.deepEqual(
            events.map(event => event.type),
            ['stream', 'discarded', 'stream']
        );
        assert.equal(requests.length, 2);
        assert.deepEqual(await transcript(sessionId), [
            ['user', 'hi', ''],
            ['assistant', 'Hello', 'completed'],
        ]);
        const types = (await store.read(sessionId)).map(record => record.body.type);
        assert.equal(types.filter(type => type === 'retry.scheduled').length, 1);
    });

    it('fails without retrying a non-retryable error', async () => {
        const { models, requests } = scripted(async function* () {
            yield* [];
            throw new ApplicationError({
                category: 'authentication',
                retry: { kind: 'after-change', change: 'credential' },
                outcome: 'rejected',
            });
        });
        const sessionId = await sessionWith('hi');
        await drain(
            new Agent(store, models, { sleep: noSleep }).run(
                sessionId,
                'user',
                new AbortController().signal
            )
        );
        assert.equal(requests.length, 1);
        const view = await store.view(sessionId);
        assert.equal(view.lastRun?.result.outcome, 'failed');
    });

    it('keeps the partial answer on Stop and tells the next step about the interruption', async () => {
        let release: () => void = () => {};
        const { models, requests } = scripted(async function* (_request, signal, attempt) {
            if (attempt === 1) {
                yield { type: 'text-delta', text: 'Once upon' };
                await new Promise<void>(resolve => {
                    release = resolve;
                    signal.addEventListener('abort', () => resolve(), { once: true });
                });
                signal.throwIfAborted();
            }
            yield { type: 'text-delta', text: 'ok' };
            yield { type: 'completed', usage: {} };
        });
        const agent = new Agent(store, models, { sleep: noSleep });
        const sessionId = await sessionWith('tell a story');
        const controller = new AbortController();
        const iterator = agent.run(sessionId, 'user', controller.signal)[Symbol.asyncIterator]();
        assert.equal((await iterator.next()).value?.type, 'stream');
        const view = await store.view(sessionId);
        const runId = view.run?.runId ?? '';
        const pending = iterator.next();
        await store.execute({
            type: 'interrupt',
            sessionId,
            operationId: randomUUID(),
            runId,
            reason: 'user',
            observedAt: new Date().toISOString(),
        });
        controller.abort();
        release();
        assert.equal((await pending).done, true);
        assert.deepEqual(await transcript(sessionId), [
            ['user', 'tell a story', ''],
            ['assistant', 'Once upon', 'interrupted'],
        ]);
        assert.deepEqual((await store.view(sessionId)).lastRun?.result, {
            outcome: 'interrupted',
            reason: 'user',
        });
        await say(sessionId, 'go on');
        await drain(agent.run(sessionId, 'user', new AbortController().signal));
        assert.deepEqual(
            requests[1].messages.map(message =>
                message.blocks.map(block => ('text' in block ? block.text : '')).join('')
            ),
            [
                'tell a story',
                'Once upon',
                '<system-reminder>The user interrupted you.</system-reminder>',
                'go on',
            ]
        );
    });

    it('rejects a request above the input budget without calling the model', async () => {
        const { models, requests } = scripted(async function* () {
            yield { type: 'completed', usage: {} };
        }, 5);
        const sessionId = await sessionWith('this message is far too long for the tiny budget');
        await drain(new Agent(store, models).run(sessionId, 'user', new AbortController().signal));
        assert.equal(requests.length, 0);
        const result = (await store.view(sessionId)).lastRun?.result;
        assert.equal(result?.outcome === 'failed' && result.failure.category, 'context-limit');
    });
});
