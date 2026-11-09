import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CompiledSchema, PluginHost, Store, ToolRuntime } from '@whimkit/core';
import { ApplicationError, knownFiles } from '@whimkit/core/contracts';

import { Agent } from './agent.js';

import type { AgentCompaction, AgentEvent } from './agent.js';
import type { Review, ReviewRequest, Reviewer, ToolModels } from '@whimkit/core';
import type { FrozenChatCard } from '@whimkit/core/contracts';
import type { ChatEvent, ChatRequest, ChatSession, ToolDefinition } from '@whimkit/core/plugin';

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
 * @param tools Declared tools.
 * @param providerTools Standard tool ids the adapter runs as separate calls.
 * @param frozen The session's card.
 * @returns The session id.
 */
async function sessionWith(
    text: string,
    tools: { name: string; description: string; inputSchema: Record<string, unknown> }[] = [],
    providerTools: string[] = [],
    frozen: FrozenChatCard = card
): Promise<string> {
    const sessionId = randomUUID();
    await store.execute({
        type: 'create',
        sessionId,
        operationId: randomUUID(),
        title: 'Chat',
        credentialId: 'cred',
        epoch: {
            epochId: randomUUID(),
            system: 'Be brief.',
            card: frozen,
            renderer: 1,
            tools,
            nativeTools: [],
            providerTools,
        },
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
            : entry.item.type === 'notice'
              ? ['notice', entry.item.kind, '']
              : ['tool', entry.item.status, entry.item.content]
    );
}

const noSleep = async () => {};
const noTools = { run: async () => {} };

/**
 * A compaction port writing transcripts under the test folder and keeping the epoch's prefix.
 * @returns The port.
 */
function compaction(): AgentCompaction {
    return {
        transcriptPath: (sessionId, compactionId) =>
            join(dir, 'transcripts', sessionId, `${compactionId}.md`),
        epoch: async view => ({
            epochId: randomUUID(),
            system: view.epoch.system,
            card: view.epoch.card,
            renderer: view.epoch.renderer,
            tools: [...view.epoch.tools],
            nativeTools: [...view.epoch.nativeTools],
            providerTools: [...view.epoch.providerTools],
        }),
    };
}

const contextLimit = new ApplicationError({
    category: 'context-limit',
    retry: { kind: 'after-change', change: 'input' },
    outcome: 'rejected',
});

/**
 * Whether a request asks for a compaction summary.
 * @param request The request.
 * @returns True for summary requests.
 */
function isSummary(request: ChatRequest): boolean {
    return request.messages.some(
        message =>
            message.role === 'user' &&
            message.blocks.some(
                block =>
                    block.type === 'text' && block.text.includes('will be replaced by your summary')
            )
    );
}

/**
 * A summary reply with every section.
 * @param text Each section's content.
 * @returns The reply.
 */
const tagged = (text: string) =>
    ['goal', 'current-state', 'progress', 'findings', 'next-steps']
        .map(name => `<${name}>${text}</${name}>`)
        .join('\n');

/**
 * The stored form of a summary whose sections all hold `text`.
 * @param text Each section's content.
 * @returns The summary.
 */
const stored = (text: string) =>
    ['goal', 'current-state', 'progress', 'findings', 'next-steps']
        .map(name => `<${name}>\n${text}\n</${name}>`)
        .join('\n\n');

/**
 * The text of a request message.
 * @param message The message.
 * @returns Its text blocks or tool content.
 */
const textOf = (message: ChatRequest['messages'][number] | undefined) =>
    !message
        ? ''
        : message.role === 'tool'
          ? message.content
          : message.blocks.map(block => (block.type === 'text' ? block.text : '')).join('');

describe('Agent', () => {
    it('streams a reply, commits it once, and does not call the model again without input', async () => {
        const { models, requests } = scripted(async function* () {
            yield { type: 'text-delta', text: 'Hi ' };
            yield { type: 'text-delta', text: 'there' };
            yield { type: 'completed', usage: { outputTokens: 2 } };
        });
        const agent = new Agent(store, models, noTools, { sleep: noSleep });
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
        const agent = new Agent(store, models, noTools, { sleep: noSleep });
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
            new Agent(store, models, noTools, { sleep: noSleep }).run(
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
            new Agent(store, models, noTools, { sleep: noSleep }).run(
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
        const agent = new Agent(store, models, noTools, { sleep: noSleep });
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
                message.role === 'tool'
                    ? message.content
                    : message.blocks.map(block => ('text' in block ? block.text : '')).join('')
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
        await drain(
            new Agent(store, models, noTools).run(sessionId, 'user', new AbortController().signal)
        );
        assert.equal(requests.length, 0);
        const result = (await store.view(sessionId)).lastRun?.result;
        assert.equal(result?.outcome === 'failed' && result.failure.category, 'context-limit');
    });

    it("summarizes in the step's own request and keeps the latest input verbatim", async () => {
        const long = (letter: string) => letter.repeat(900);
        // The threshold (80% of the window) is below the budget, as with real cards.
        const { models, requests } = scripted(async function* (request) {
            yield {
                type: 'text-delta',
                text: isSummary(request) ? tagged('S') : long('a'),
            };
            yield { type: 'completed', usage: { inputTokens: 5, outputTokens: 1 } };
        }, 3000);
        const agent = new Agent(store, models, noTools, {
            sleep: noSleep,
            compaction: compaction(),
            now: () => new Date('2026-11-09T12:00:00Z'),
        });
        const sessionId = await sessionWith(long('u'), [], [], { ...card, contextWindow: 1000 });
        await drain(agent.run(sessionId, 'user', new AbortController().signal));
        await say(sessionId, long('v'));
        await drain(agent.run(sessionId, 'user', new AbortController().signal));

        const view = await store.view(sessionId);
        const latest = view.history.findLast(
            entry => entry.item.type === 'message' && entry.item.role === 'user'
        );
        assert.equal(view.epoch.reason, 'compaction');
        assert.deepEqual(
            view.compactions.map(item => [item.state, item.summary]),
            [['succeeded', stored('S')]]
        );
        // Every entry was too large for the tail, so all are summarized and the input is kept.
        assert.equal(view.epoch.context?.input, latest?.seq);
        const from = view.epoch.context?.from ?? 0;
        assert.deepEqual(
            view.history.filter(entry => entry.seq >= from).map(entry => entry.item.type),
            ['message']
        );
        assert.ok(from > (latest?.seq ?? Infinity));
        const transcript = await readFile(
            fileURLToPath(view.epoch.context?.transcript ?? 'file:///missing'),
            'utf8'
        );
        assert.equal(
            transcript,
            `### User\n${long('u')}\n\n### Assistant\n${long('a')}\n\n### User\n${long('v')}\n`
        );
        const [, summary, last] = requests;
        assert.equal(requests.length, 3);
        // The summary request is the step's own: same system, tools, thinking, and history.
        assert.equal(summary?.system, 'Be brief.');
        assert.equal(summary?.thinking, 'high');
        assert.deepEqual(summary?.messages.slice(0, 3), [
            { role: 'user', blocks: [{ type: 'text', text: long('u') }] },
            { role: 'assistant', blocks: [{ type: 'text', text: long('a') }] },
            { role: 'user', blocks: [{ type: 'text', text: long('v') }] },
        ]);
        assert.match(textOf(summary?.messages[3]), /It is now 2026-11-09T12:00:00\.000Z\./);
        assert.equal(summary?.messages.length, 4);
        assert.match(
            textOf(last?.messages[0]),
            /^<system-reminder>The earlier part of this conversation was compacted[\s\S]*The user's latest message follows verbatim\.[\s\S]*<next-steps>\nS\n<\/next-steps><\/system-reminder>$/
        );
        assert.deepEqual(last?.messages.slice(1), [
            { role: 'user', blocks: [{ type: 'text', text: long('v') }] },
        ]);
        assert.deepEqual(view.usage, { inputTokens: 15, outputTokens: 3 });
    });

    it('compacts and runs the step again when the provider reports the context limit', async () => {
        const { models, requests } = scripted(async function* (request) {
            if (isSummary(request)) yield { type: 'text-delta', text: tagged('S') };
            else if (
                request.messages.length === 3 &&
                request.messages.some(message => textOf(message) === 'first')
            )
                throw contextLimit;
            else yield { type: 'text-delta', text: 'ok' };
            yield { type: 'completed', usage: {} };
        });
        const agent = new Agent(store, models, noTools, {
            sleep: noSleep,
            compaction: compaction(),
        });
        const sessionId = await sessionWith('first');
        await drain(agent.run(sessionId, 'user', new AbortController().signal));
        await say(sessionId, 'second');
        await drain(agent.run(sessionId, 'user', new AbortController().signal));
        const view = await store.view(sessionId);
        assert.deepEqual(view.lastRun?.result, { outcome: 'completed' });
        assert.deepEqual(
            requests.map(request => request.messages.length),
            [1, 3, 2, 3]
        );
        // The summary request repeats the refused request up to the kept tail.
        const [, refused, summary] = requests;
        assert.deepEqual(summary?.messages[0], refused?.messages[0]);
        assert.deepEqual(summary?.tools, refused?.tools);
        // The tail is small, so it stays: only the first message is summarized.
        const kept = view.history.find(
            entry => entry.item.type === 'message' && entry.item.role === 'assistant'
        );
        assert.deepEqual(view.epoch.context && { ...view.epoch.context, transcript: '' }, {
            summary: stored('S'),
            from: kept?.seq,
            transcript: '',
        });
        assert.deepEqual(
            view.compactions.map(item => item.state),
            ['succeeded']
        );
        assert.deepEqual(await transcript(sessionId), [
            ['user', 'first', ''],
            ['assistant', 'ok', 'completed'],
            ['user', 'second', ''],
            ['assistant', 'ok', 'completed'],
        ]);
    });

    it('fails with the provider context limit when compaction fails, without resending', async () => {
        const { models, requests } = scripted(async function* (request) {
            if (isSummary(request)) throw new Error('summary failed');
            if (request.messages.length === 3) throw contextLimit;
            yield { type: 'text-delta', text: 'ok' };
            yield { type: 'completed', usage: {} };
        });
        const agent = new Agent(store, models, noTools, {
            sleep: noSleep,
            compaction: compaction(),
        });
        const sessionId = await sessionWith('first');
        await drain(agent.run(sessionId, 'user', new AbortController().signal));
        await say(sessionId, 'second');
        await drain(agent.run(sessionId, 'user', new AbortController().signal));
        const view = await store.view(sessionId);
        assert.deepEqual(view.lastRun?.result, {
            outcome: 'failed',
            failure: contextLimit.failure,
        });
        assert.equal(requests.length, 3);
        assert.deepEqual(
            view.compactions.map(item => item.state),
            ['failed']
        );
    });

    it('asks once more when a section is missing and records each summary request', async () => {
        const long = (letter: string) => letter.repeat(900);
        let summaries = 0;
        const { models, requests } = scripted(async function* (request) {
            if (isSummary(request)) {
                summaries++;
                yield {
                    type: 'text-delta',
                    text: summaries === 1 ? '<goal>G</goal> and some prose' : tagged('T'),
                };
            } else yield { type: 'text-delta', text: long('a') };
            yield { type: 'completed', usage: { inputTokens: 5, outputTokens: 1 } };
        }, 3000);
        const agent = new Agent(store, models, noTools, {
            sleep: noSleep,
            compaction: compaction(),
        });
        const sessionId = await sessionWith(long('u'), [], [], { ...card, contextWindow: 1000 });
        await drain(agent.run(sessionId, 'user', new AbortController().signal));
        await say(sessionId, long('v'));
        await drain(agent.run(sessionId, 'user', new AbortController().signal));

        const view = await store.view(sessionId);
        assert.deepEqual(
            view.compactions.map(item => [item.state, item.summary]),
            [['succeeded', stored('T')]]
        );
        const again = requests[2];
        assert.deepEqual(
            again?.messages.slice(-2).map(message => [message.role, textOf(message)]),
            [
                ['assistant', '<goal>G</goal> and some prose'],
                [
                    'user',
                    '<system-reminder>Your summary is missing <current-state>, <progress>, <findings>, <next-steps>. Write the complete summary again with all five sections, and nothing else.</system-reminder>',
                ],
            ]
        );
        // Both summary requests count toward the session's usage.
        assert.deepEqual(view.usage, { inputTokens: 20, outputTokens: 4 });
    });

    it('asks once more when the summary is cut off and keeps the second reply as written', async () => {
        const long = (letter: string) => letter.repeat(900);
        let summaries = 0;
        const { models } = scripted(async function* (request) {
            if (isSummary(request)) {
                summaries++;
                yield { type: 'text-delta', text: summaries === 1 ? '<goal>G' : 'plain prose' };
                if (summaries === 1)
                    throw new ApplicationError({
                        category: 'output-limit',
                        retry: { kind: 'never' },
                        outcome: 'partial',
                    });
            } else yield { type: 'text-delta', text: long('a') };
            yield { type: 'completed', usage: {} };
        }, 3000);
        const agent = new Agent(store, models, noTools, {
            sleep: noSleep,
            compaction: compaction(),
        });
        const sessionId = await sessionWith(long('u'), [], [], { ...card, contextWindow: 1000 });
        await drain(agent.run(sessionId, 'user', new AbortController().signal));
        await say(sessionId, long('v'));
        await drain(agent.run(sessionId, 'user', new AbortController().signal));
        const view = await store.view(sessionId);
        assert.deepEqual(
            view.compactions.map(item => [item.state, item.summary]),
            [['succeeded', 'plain prose']]
        );
        assert.deepEqual(view.lastRun?.result, { outcome: 'completed' });
    });

    it('summarizes the older half when the provider refuses the summary request', async () => {
        const { models, requests } = scripted(async function* (request) {
            const texts = request.messages.map(textOf);
            if (
                isSummary(request)
                    ? texts.includes('m3')
                    : texts.includes('m1') && texts.includes('go')
            )
                throw contextLimit;
            yield { type: 'text-delta', text: isSummary(request) ? tagged('S') : 'ok' };
            yield { type: 'completed', usage: {} };
        });
        const agent = new Agent(store, models, noTools, {
            sleep: noSleep,
            compaction: compaction(),
        });
        const sessionId = await sessionWith('m1');
        await drain(agent.run(sessionId, 'user', new AbortController().signal));
        for (const text of ['m2', 'm3', 'm4', 'm5', 'm6', 'go']) {
            await say(sessionId, text);
            await drain(agent.run(sessionId, 'user', new AbortController().signal));
        }
        const view = await store.view(sessionId);
        assert.deepEqual(view.lastRun?.result, { outcome: 'completed' });
        assert.deepEqual(
            view.compactions.map(item => item.state),
            ['succeeded']
        );
        // The first cut kept the last six entries; the accepted one covers m1, its reply, and m2.
        const summaries = requests.filter(isSummary);
        assert.deepEqual(
            summaries.map(request => request.messages.slice(0, -1).map(textOf)),
            [
                ['m1', 'ok', 'm2', 'ok', 'm3', 'ok', 'm4'],
                ['m1', 'ok', 'm2'],
            ]
        );
        assert.equal(view.epoch.context?.from, view.history[3]?.seq);
    });

    it('shortens a single long entry in the middle until the summary request is accepted', async () => {
        const huge = 'h'.repeat(9000);
        const { models, requests } = scripted(async function* (request) {
            const texts = request.messages.map(textOf);
            if (
                isSummary(request)
                    ? texts.some(text => text.length > 4000)
                    : texts.includes(huge) && texts.includes('next')
            )
                throw contextLimit;
            yield { type: 'text-delta', text: isSummary(request) ? tagged('S') : 'ok' };
            yield { type: 'completed', usage: {} };
        });
        const agent = new Agent(store, models, noTools, {
            sleep: noSleep,
            compaction: compaction(),
        });
        const sessionId = await sessionWith(huge);
        await drain(agent.run(sessionId, 'user', new AbortController().signal));
        await say(sessionId, 'next');
        await drain(agent.run(sessionId, 'user', new AbortController().signal));
        const view = await store.view(sessionId);
        assert.deepEqual(view.lastRun?.result, { outcome: 'completed' });
        const summaries = requests.filter(isSummary);
        assert.deepEqual(
            summaries.map(request => textOf(request.messages[0]).length),
            [9000, 4500 + 31, 2250 + 31]
        );
        assert.equal(
            textOf(summaries.at(-1)?.messages[0]),
            `${'h'.repeat(1125)}\n[… 6750 characters omitted …]\n${'h'.repeat(1125)}`
        );
    });

    describe('tools', () => {
        const textSchema = {
            type: 'object',
            required: ['text'],
            additionalProperties: false,
            properties: { text: { type: 'string' } },
        };

        /**
         * A tool runtime over a host holding the given tools.
         * @param tools Tool definitions.
         * @param toolModels Bindings for provider-run tools.
         * @param reviewer The auto-mode reviewer, if any.
         * @returns The runtime, its declarations, and sessions whose jobs ended.
         */
        function runtimeWith(
            tools: ToolDefinition<{ text: string }>[],
            toolModels: ToolModels = {
                open: () => Promise.reject(new Error('No provider tools here.')),
            },
            reviewer?: Reviewer
        ) {
            const host = new PluginHost(store, []);
            for (const tool of tools)
                host.tools.set(tool.name, {
                    pluginId: 'test',
                    tool,
                    inputSchema: new CompiledSchema(tool.inputSchema),
                });
            const ended: string[] = [];
            const runtime = new ToolRuntime(
                store,
                host,
                toolModels,
                {
                    list: async () => [],
                    resolve: () => Promise.reject(new Error('No credentials.')),
                },
                [],
                join(dir, 'sessions'),
                undefined,
                id => ended.push(id),
                async () => reviewer
            );
            return { runtime, declarations: runtime.declarations(undefined, []), ended };
        }

        const echo: ToolDefinition<{ text: string }> = {
            name: 'Echo',
            description: 'Echo text.',
            inputSchema: textSchema,
            readOnly: true,
            concurrencySafe: true,
            needsWorkspace: false,
            access: () => [],
            execute: async input => ({ content: `echo: ${input.text}` }),
        };

        /**
         * A model that calls a tool once and then answers with the tool result it saw.
         * @param name Tool to call.
         * @param args Its JSON arguments.
         * @returns The model port and recorded requests.
         */
        function callingModel(name: string, args: string) {
            return scripted(async function* (request, _signal, attempt) {
                if (attempt === 1) {
                    yield { type: 'tool-call', callId: 'call-1', name, arguments: args };
                } else {
                    const result = request.messages.find(message => message.role === 'tool');
                    yield {
                        type: 'text-delta',
                        text: `saw ${result?.role === 'tool' ? result.status : 'nothing'}`,
                    };
                }
                yield { type: 'completed', usage: {} };
            });
        }

        it('runs a call, commits its result, and answers in the same run', async () => {
            const { runtime, declarations } = runtimeWith([echo]);
            const { models, requests } = callingModel('Echo', '{"text":"hi"}');
            const sessionId = await sessionWith('use echo', declarations);
            const agent = new Agent(store, models, runtime, { sleep: noSleep });
            await drain(agent.run(sessionId, 'user', new AbortController().signal));
            assert.deepEqual(await transcript(sessionId), [
                ['user', 'use echo', ''],
                ['assistant', '', 'completed'],
                ['tool', 'success', 'echo: hi'],
                ['assistant', 'saw success', 'completed'],
            ]);
            assert.deepEqual(
                requests[1].messages.map(message => message.role),
                ['user', 'assistant', 'tool']
            );
            assert.deepEqual(
                requests[0].tools.map(tool => tool.name),
                ['Echo', 'JobOutput', 'JobStop']
            );
            assert.equal((await store.view(sessionId)).lastRun?.result.outcome, 'completed');
        });

        it('runs a provider tool through the adapter and counts its tokens apart from context', async () => {
            const calls: unknown[] = [];
            const fetcher = { ...echo, name: 'WebFetch', standard: 'web_fetch' as const };
            const { runtime, declarations } = runtimeWith([fetcher], {
                open: async () => ({
                    inputBudget: () => 1000,
                    stream: () => {
                        throw new Error('unused');
                    },
                    runTool: async (tool, input, options) => {
                        calls.push([tool, input, options.thinking]);
                        return {
                            output: { content: 'page text' },
                            usage: { inputTokens: 40, outputTokens: 5 },
                        };
                    },
                }),
            });
            const { models } = callingModel('WebFetch', '{"text":"https://a.example"}');
            const sessionId = await sessionWith('fetch it', declarations, ['web_fetch']);
            await drain(
                new Agent(store, models, runtime, { sleep: noSleep }).run(
                    sessionId,
                    'user',
                    new AbortController().signal
                )
            );
            assert.deepEqual(calls, [['web_fetch', { text: 'https://a.example' }, 'high']]);
            assert.deepEqual((await transcript(sessionId))[2], ['tool', 'success', 'page text']);
            const view = await store.view(sessionId);
            assert.deepEqual(view.usage, { inputTokens: 40, outputTokens: 5 });
            assert.equal(view.lastUsage, undefined);
        });

        it("offloads a large result into the session's folder and references it by file URI", async () => {
            const big = 'x'.repeat(40 * 1024);
            const { runtime, declarations } = runtimeWith([
                { ...echo, execute: async () => ({ content: big }) },
            ]);
            const { models } = callingModel('Echo', '{"text":"hi"}');
            const sessionId = await sessionWith('big output', declarations);
            await drain(
                new Agent(store, models, runtime, { sleep: noSleep }).run(
                    sessionId,
                    'user',
                    new AbortController().signal
                )
            );
            const result = (await store.view(sessionId)).history.find(
                entry => entry.item.type === 'tool_result'
            )?.item;
            assert.ok(result?.type === 'tool_result');
            const path = join(runtime.sessionDir(sessionId), 'offload', 'call-1.txt');
            assert.deepEqual(result.offload, { path, bytes: big.length });
            assert.ok(result.content.includes(pathToFileURL(path).href));
            assert.equal(await readFile(path, 'utf8'), big);
        });

        it('gives later calls the files read before and forgets them after compaction', async () => {
            const version = { path: '/w/a.txt', mtimeMs: 1, size: 3 };
            const touch: ToolDefinition<{ text: string }> = {
                ...echo,
                name: 'Touch',
                execute: async () => ({ content: 'read a.txt', files: [version] }),
            };
            const check: ToolDefinition<{ text: string }> = {
                ...echo,
                name: 'Check',
                execute: async (_input, context) => ({
                    content: `known: ${JSON.stringify(context.knownFiles.get(version.path) ?? null)}`,
                }),
            };
            const { runtime, declarations } = runtimeWith([touch, check]);
            const long = (letter: string) => letter.repeat(4000);
            const call = (name: string) =>
                ({
                    type: 'tool-call',
                    callId: randomUUID(),
                    name,
                    arguments: '{"text":"x"}',
                }) as const;
            let compacted = false;
            const { models } = scripted(async function* (request) {
                const last = request.messages.at(-1);
                if (isSummary(request)) {
                    compacted = true;
                    yield { type: 'text-delta', text: tagged('S') };
                } else if (last?.role === 'user') yield call(compacted ? 'Check' : 'Touch');
                else if (last?.role === 'tool' && last.content === 'read a.txt')
                    yield call('Check');
                else yield { type: 'text-delta', text: long('a') };
                yield { type: 'completed', usage: {} };
            }, 2000);
            const agent = new Agent(store, models, runtime, {
                sleep: noSleep,
                compaction: compaction(),
            });
            const sessionId = await sessionWith('read it', declarations);
            await drain(agent.run(sessionId, 'user', new AbortController().signal));
            const before = await store.view(sessionId);
            assert.deepEqual([...knownFiles(before).values()], [version]);
            assert.deepEqual(
                before.history.flatMap(entry =>
                    entry.item.type === 'tool_result' ? [entry.item.content] : []
                ),
                ['read a.txt', `known: ${JSON.stringify(version)}`]
            );

            await say(sessionId, long('v'));
            await drain(agent.run(sessionId, 'user', new AbortController().signal));
            const after = await store.view(sessionId);
            assert.equal(after.epoch.reason, 'compaction');
            assert.equal(knownFiles(after).size, 0);
            // The call after the compaction no longer sees the earlier read.
            const results = after.history.flatMap(entry =>
                entry.item.type === 'tool_result' ? [entry.item.content] : []
            );
            assert.equal(results.at(-1), 'known: null');
        });

        it('compacts inside a long run of tool calls, keeping each call with its results', async () => {
            const { runtime, declarations } = runtimeWith([echo]);
            let calls = 0;
            const { models, requests } = scripted(async function* (request) {
                if (isSummary(request)) yield { type: 'text-delta', text: tagged('S') };
                else if (calls < 12)
                    yield {
                        type: 'tool-call',
                        callId: `call-${++calls}`,
                        name: 'Echo',
                        arguments: JSON.stringify({ text: 'x'.repeat(300) }),
                    };
                else yield { type: 'text-delta', text: 'done' };
                yield { type: 'completed', usage: {} };
            });
            const agent = new Agent(store, models, runtime, {
                sleep: noSleep,
                compaction: compaction(),
            });
            const sessionId = await sessionWith('loop', declarations, [], {
                ...card,
                contextWindow: 2000,
            });
            await drain(agent.run(sessionId, 'user', new AbortController().signal));
            const view = await store.view(sessionId);
            assert.deepEqual(view.lastRun?.result, { outcome: 'completed' });
            assert.ok(view.compactions.length > 0);
            assert.ok(view.compactions.every(item => item.state === 'succeeded'));
            const user = view.history.find(
                entry => entry.item.type === 'message' && entry.item.role === 'user'
            );
            assert.equal(view.epoch.context?.input, user?.seq);
            // Every request keeps tool results right after the message that called them.
            for (const request of requests)
                request.messages.forEach((message, index) => {
                    if (message.role !== 'tool') return;
                    const caller = request.messages
                        .slice(0, index)
                        .findLast(item => item.role !== 'tool');
                    assert.ok(
                        caller?.role === 'assistant' &&
                            caller.blocks.some(
                                block =>
                                    block.type === 'tool_call' && block.callId === message.callId
                            )
                    );
                });
            const last = requests.at(-1);
            assert.deepEqual(
                last?.messages
                    .slice(0, 3)
                    .map(message => [message.role, textOf(message).slice(0, 18)]),
                [
                    ['user', '<system-reminder>T'],
                    ['user', 'loop'],
                    ['assistant', ''],
                ]
            );
        });

        it('reports invalid arguments to the model without running the tool', async () => {
            let ran = false;
            const { runtime, declarations } = runtimeWith([
                { ...echo, execute: async () => ((ran = true), { content: '' }) },
            ]);
            const { models } = callingModel('Echo', '{"text":1}');
            const sessionId = await sessionWith('bad args', declarations);
            await drain(
                new Agent(store, models, runtime, { sleep: noSleep }).run(
                    sessionId,
                    'user',
                    new AbortController().signal
                )
            );
            const result = (await transcript(sessionId))[2];
            assert.equal(result?.[1], 'error');
            assert.match(String(result?.[2]), /Invalid arguments/);
            assert.equal(ran, false);
        });

        it('asks before writing and records a denial', async () => {
            const writer = {
                ...echo,
                name: 'Write',
                readOnly: false,
                concurrencySafe: false,
                access: () => [{ kind: 'write' as const, path: '/tmp/x' }],
            };
            const { runtime, declarations } = runtimeWith([writer]);
            const { models } = callingModel('Write', '{"text":"x"}');
            const sessionId = await sessionWith('write it', declarations);
            const stop = store.onCommit(records => {
                if (records.some(record => record.body.type === 'permission.requested'))
                    void runtime.decide(sessionId, 'call-1', 'deny', 'once');
            });
            await drain(
                new Agent(store, models, runtime, { sleep: noSleep }).run(
                    sessionId,
                    'user',
                    new AbortController().signal
                )
            );
            stop();
            assert.deepEqual((await transcript(sessionId)).slice(2), [
                ['tool', 'denied', 'The user denied this tool call.'],
                ['assistant', 'saw denied', 'completed'],
            ]);
        });

        it('grants a session rule so the next identical call does not ask', async () => {
            const writer = {
                ...echo,
                name: 'Write',
                readOnly: false,
                concurrencySafe: false,
                access: () => [{ kind: 'execute' as const, command: 'ls -la' }],
            };
            const { runtime, declarations } = runtimeWith([writer]);
            const sessionId = await sessionWith('first', declarations);
            let asks = 0;
            const stop = store.onCommit(records => {
                for (const record of records)
                    if (record.body.type === 'permission.requested') {
                        asks++;
                        void runtime.decide(sessionId, record.body.callId, 'allow', 'session');
                    }
            });
            for (const round of [1, 2]) {
                const { models } = scripted(async function* (_request, _signal, attempt) {
                    if (attempt === 1)
                        yield {
                            type: 'tool-call',
                            callId: `call-${round}`,
                            name: 'Write',
                            arguments: '{"text":"x"}',
                        };
                    else yield { type: 'text-delta', text: 'ok' };
                    yield { type: 'completed', usage: {} };
                });
                if (round === 2) await say(sessionId, 'again');
                await drain(
                    new Agent(store, models, runtime, { sleep: noSleep }).run(
                        sessionId,
                        'user',
                        new AbortController().signal
                    )
                );
            }
            stop();
            assert.equal(asks, 1);
            assert.deepEqual((await store.view(sessionId)).permissionRules, [
                { tool: 'Write', kind: 'execute', pattern: 'ls' },
            ]);
        });

        describe('automatic review', () => {
            const writer = {
                ...echo,
                name: 'Write',
                readOnly: false,
                concurrencySafe: false,
                access: () => [{ kind: 'write' as const, path: '/tmp/x' }],
            };

            /**
             * A reviewer with a fixed answer that records what it was asked.
             * @param answer The review, or an error to throw.
             * @returns The reviewer and its requests.
             */
            function fixedReviewer(answer: Review | Error) {
                const requests: ReviewRequest[] = [];
                const reviewer: Reviewer = {
                    cardId: 'test/reviewer',
                    review: async request => {
                        requests.push(request);
                        if (answer instanceof Error) throw answer;
                        return answer;
                    },
                };
                return { reviewer, requests };
            }

            /**
             * Run one turn that calls Write and collect the permission records.
             * @param reviewer The reviewer.
             * @param onAsk Answers a call left to the user.
             * @returns The session, its transcript tail, and the permission record bodies.
             */
            async function turn(
                reviewer: Reviewer,
                onAsk?: (runtime: ToolRuntime, sessionId: string, callId: string) => void
            ) {
                const { runtime, declarations } = runtimeWith([writer], undefined, reviewer);
                const { models } = callingModel('Write', '{"text":"x"}');
                const sessionId = await sessionWith('write it', declarations);
                const bodies: unknown[] = [];
                const stop = store.onCommit(records => {
                    for (const { body } of records) {
                        if (body.type.startsWith('permission.')) bodies.push(body);
                        if (body.type === 'permission.reviewed' && body.outcome === 'ask')
                            onAsk?.(runtime, sessionId, body.callId);
                    }
                });
                await drain(
                    new Agent(store, models, runtime, { sleep: noSleep }).run(
                        sessionId,
                        'user',
                        new AbortController().signal
                    )
                );
                stop();
                const view = await store.view(sessionId);
                return { view, tail: (await transcript(sessionId)).slice(2), bodies };
            }

            it('runs an allowed call without asking and counts the review usage', async () => {
                const { reviewer, requests } = fixedReviewer({
                    outcome: 'allow',
                    reason: 'The user asked to write.',
                    usage: { inputTokens: 40, outputTokens: 5 },
                });
                const { view, tail, bodies } = await turn(reviewer);
                assert.deepEqual(tail, [
                    ['tool', 'success', 'echo: x'],
                    ['assistant', 'saw success', 'completed'],
                ]);
                assert.deepEqual(bodies, [
                    {
                        type: 'permission.requested',
                        runId: view.lastRun?.runId,
                        callId: 'call-1',
                        name: 'Write',
                        access: [{ kind: 'write', path: '/tmp/x' }],
                        reviewer: { cardId: 'test/reviewer' },
                    },
                    {
                        type: 'permission.reviewed',
                        runId: view.lastRun?.runId,
                        callId: 'call-1',
                        outcome: 'allow',
                        reason: 'The user asked to write.',
                        usage: { inputTokens: 40, outputTokens: 5 },
                    },
                ]);
                assert.deepEqual(requests, [
                    {
                        tool: { name: 'Write', description: 'Echo text.' },
                        input: { text: 'x' },
                        access: [{ kind: 'write', path: '/tmp/x' }],
                        requests: ['write it'],
                    },
                ]);
                assert.equal(view.usage.inputTokens, 40);
                assert.deepEqual(view.permissionRules, []);
            });

            it("gives the model the reviewer's reason for a denial", async () => {
                const { reviewer } = fixedReviewer({
                    outcome: 'deny',
                    reason: 'Nobody asked for this file.',
                    usage: {},
                });
                const { tail } = await turn(reviewer);
                assert.deepEqual(tail, [
                    [
                        'tool',
                        'denied',
                        'The automatic reviewer denied this tool call: Nobody asked for this file. Do not retry the same call; choose another way or ask the user.',
                    ],
                    ['assistant', 'saw denied', 'completed'],
                ]);
            });

            it('leaves the call to the user when the review fails', async () => {
                const { reviewer } = fixedReviewer(
                    new ApplicationError({
                        category: 'rate-limited',
                        retry: { kind: 'backoff' },
                        outcome: 'rejected',
                        detail: { provider: 'test', message: 'Slow down.' },
                    })
                );
                const { tail, bodies } = await turn(reviewer, (runtime, sessionId, callId) => {
                    void runtime.decide(sessionId, callId, 'allow', 'once');
                });
                assert.deepEqual(bodies.at(1), {
                    type: 'permission.reviewed',
                    runId: (bodies[0] as { runId: string }).runId,
                    callId: 'call-1',
                    outcome: 'ask',
                    reason: 'Slow down.',
                    usage: {},
                    failure: {
                        category: 'rate-limited',
                        retry: { kind: 'backoff' },
                        outcome: 'rejected',
                        detail: { provider: 'test', message: 'Slow down.' },
                    },
                });
                assert.equal((bodies.at(2) as { type: string }).type, 'permission.decided');
                assert.deepEqual(tail[0], ['tool', 'success', 'echo: x']);
            });
        });

        it('cancels an open ask on Stop and closes the call', async () => {
            const writer = {
                ...echo,
                name: 'Write',
                readOnly: false,
                concurrencySafe: false,
                access: () => [{ kind: 'write' as const, path: '/tmp/x' }],
            };
            const { runtime, declarations } = runtimeWith([writer]);
            const { models } = callingModel('Write', '{"text":"x"}');
            const sessionId = await sessionWith('write it', declarations);
            const agent = new Agent(store, models, runtime, { sleep: noSleep });
            const controller = new AbortController();
            const stop = store.onCommit(records => {
                const asked = records.find(record => record.body.type === 'permission.requested');
                if (asked?.body.type === 'permission.requested')
                    void store
                        .execute({
                            type: 'interrupt',
                            sessionId,
                            operationId: randomUUID(),
                            runId: asked.body.runId,
                            reason: 'user',
                            observedAt: new Date().toISOString(),
                        })
                        .then(() => controller.abort());
            });
            await drain(agent.run(sessionId, 'user', controller.signal));
            stop();
            const view = await store.view(sessionId);
            assert.deepEqual(view.calls, []);
            assert.equal((await transcript(sessionId))[2]?.[1], 'cancelled');
            assert.deepEqual(view.lastRun?.result, { outcome: 'interrupted', reason: 'user' });
        });

        it('moves a slow call to the background and delivers its completion', async () => {
            let finish!: () => void;
            const released = new Promise<void>(resolve => (finish = resolve));
            const slow: ToolDefinition<{ text: string }> = {
                ...echo,
                name: 'Slow',
                backgroundAfterMs: () => 0,
                execute: async (input, context) => {
                    context.output('started\n');
                    await released;
                    return { content: `done ${input.text}` };
                },
            };
            const { runtime, declarations, ended } = runtimeWith([slow]);
            const { models } = callingModel('Slow', '{"text":"job"}');
            const sessionId = await sessionWith('run slow', declarations);
            await drain(
                new Agent(store, models, runtime, { sleep: noSleep }).run(
                    sessionId,
                    'user',
                    new AbortController().signal
                )
            );
            let view = await store.view(sessionId);
            assert.equal(view.jobs.length, 1);
            const jobId = view.jobs[0]?.jobId ?? '';
            assert.equal((await transcript(sessionId))[2]?.[1], 'background');
            finish();
            while (ended.length === 0) await new Promise(resolve => setTimeout(resolve, 10));
            view = await store.view(sessionId);
            assert.deepEqual(view.jobs, []);
            const notice = [...view.inbox.values()][0]?.item;
            assert.ok(notice?.type === 'notice' && notice.kind === 'job-finished');
            assert.deepEqual(notice.payload, {
                jobId,
                callId: 'call-1',
                tool: 'Slow',
                status: 'completed',
            });
            assert.equal(notice.text, 'done job');
        });

        it('offloads a large result to a file and keeps a preview', async () => {
            const big = { ...echo, execute: async () => ({ content: 'x'.repeat(100_000) }) };
            const { runtime, declarations } = runtimeWith([big]);
            const { models } = callingModel('Echo', '{"text":"x"}');
            const sessionId = await sessionWith('big', declarations);
            await drain(
                new Agent(store, models, runtime, { sleep: noSleep }).run(
                    sessionId,
                    'user',
                    new AbortController().signal
                )
            );
            const item = (await store.view(sessionId)).history[2]?.item;
            assert.ok(item?.type === 'tool_result');
            assert.equal(item.offload?.bytes, 100_000);
            assert.ok(item.content.length < 20_000);
            assert.match(item.content, /bytes omitted/);
        });

        it('records job loss on recovery', async () => {
            const slow: ToolDefinition<{ text: string }> = {
                ...echo,
                name: 'Slow',
                backgroundAfterMs: () => 0,
                execute: () => new Promise(() => {}),
            };
            const { runtime, declarations } = runtimeWith([slow]);
            const { models } = callingModel('Slow', '{"text":"x"}');
            const sessionId = await sessionWith('lose it', declarations);
            await drain(
                new Agent(store, models, runtime, { sleep: noSleep }).run(
                    sessionId,
                    'user',
                    new AbortController().signal
                )
            );
            assert.ok((await store.recoverySessions()).some(item => item.sessionId === sessionId));
            await store.execute({
                type: 'recover',
                sessionId,
                operationId: randomUUID(),
                reason: 'crash',
                observedAt: new Date().toISOString(),
            });
            const view = await store.view(sessionId);
            assert.deepEqual(view.jobs, []);
            const notice = [...view.inbox.values()][0]?.item;
            assert.equal(notice?.type === 'notice' && notice.kind, 'job-lost');
        });
    });
});
