import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CompiledSchema, PluginHost, Store, ToolRuntime } from '@whimkit/core';
import { ApplicationError } from '@whimkit/core/contracts';

import { Agent } from './agent.js';

import type { AgentEvent } from './agent.js';
import type { ToolModels } from '@whimkit/core';
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
 * @returns The session id.
 */
async function sessionWith(
    text: string,
    tools: { name: string; description: string; inputSchema: Record<string, unknown> }[] = [],
    providerTools: string[] = []
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
            card,
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

    it('compacts the history before the latest input once the threshold is passed', async () => {
        const long = (letter: string) => letter.repeat(600);
        const { models, requests } = scripted(async function* (request) {
            yield {
                type: 'text-delta',
                text: request.system.startsWith('You compact') ? 'SUMMARY' : long('a'),
            };
            yield { type: 'completed', usage: { inputTokens: 5, outputTokens: 1 } };
        }, 400);
        const transcripts = join(dir, 'transcripts');
        const agent = new Agent(store, models, noTools, {
            sleep: noSleep,
            compaction: {
                transcriptPath: (sessionId, compactionId) =>
                    join(transcripts, sessionId, `${compactionId}.md`),
                epoch: async view => ({
                    epochId: randomUUID(),
                    system: view.epoch.system,
                    card: view.epoch.card,
                    renderer: view.epoch.renderer,
                    tools: [...view.epoch.tools],
                    nativeTools: [...view.epoch.nativeTools],
                    providerTools: [...view.epoch.providerTools],
                }),
            },
        });
        const sessionId = await sessionWith(long('u'));
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
            [['succeeded', 'SUMMARY']]
        );
        assert.equal(view.epoch.context?.from, latest?.seq);
        const transcript = await readFile(
            fileURLToPath(view.epoch.context?.transcript ?? 'file:///missing'),
            'utf8'
        );
        assert.equal(transcript, `### User\n${long('u')}\n\n### Assistant\n${long('a')}\n`);
        // The summary call sees the transcript; the answer after it sees the summary and the input.
        assert.deepEqual(
            requests.map(request => request.messages.length),
            [1, 1, 2]
        );
        const last = requests.at(-1);
        assert.match(
            last?.messages[0]?.role === 'user' && last.messages[0].blocks[0]?.type === 'text'
                ? last.messages[0].blocks[0].text
                : '',
            /^<system-reminder>The earlier part of this conversation was compacted[\s\S]*SUMMARY<\/system-reminder>$/
        );
        assert.deepEqual(last?.messages[1], {
            role: 'user',
            blocks: [{ type: 'text', text: long('v') }],
        });
        assert.deepEqual(view.usage, { inputTokens: 15, outputTokens: 3 });
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
         * @returns The runtime, its declarations, and sessions whose jobs ended.
         */
        function runtimeWith(
            tools: ToolDefinition<{ text: string }>[],
            toolModels: ToolModels = {
                open: () => Promise.reject(new Error('No provider tools here.')),
            }
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
                id => ended.push(id)
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
