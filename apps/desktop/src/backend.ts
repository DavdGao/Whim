import { randomUUID } from 'node:crypto';

import { AsyncEntry } from '@napi-rs/keyring';
import { Agent } from '@whimkit/agent';
import { ApplicationError, foldRecords } from '@whimkit/core';
import { FileService } from '@whimkit/core/files';
import { SqliteStore } from '@whimkit/core/runtime';
import { resolveThinking } from '@whimkit/models';
import { card, cards, DashScopeChat } from '@whimkit/plugin-dashscope';
import { z } from 'zod';

import { commandSchema, replySchema } from './contracts.js';

import type { Reply } from './contracts.js';

const parent = process.parentPort;
if (!parent) throw new Error('Backend requires a utility process.');
const store = await SqliteStore.open(process.argv[2], process.env.WHIM_SQLITE_BINDING);
const files = new FileService(store);
let key = process.env.DASHSCOPE_API_KEY ?? '';
const runs = new Map<string, { agent: Agent; completion: Promise<void> }>();
let closing = false;

const vault = new AsyncEntry('Whim.DashScope', 'default');
if (!key) {
    try {
        key = (await vault.getPassword()) ?? '';
    } catch {
        key = '';
    }
}
for (const record of (await store.application()).records) {
    if (foldRecords(await store.read(record.sessionId)).run)
        await store.execute({
            type: 'recover',
            sessionId: record.sessionId,
            operationId: randomUUID(),
        });
}

/**
 * Return committed conversation facts and application state without exposing credentials.
 * @returns A validated desktop snapshot reply.
 * @param sessionId
 * @param beforeId
 */
async function snapshot(sessionId?: string, beforeId?: string): Promise<Reply> {
    const application = await store.application();
    const selectedId = sessionId ?? application.records[0]?.sessionId;
    return {
        ok: true,
        snapshot: {
            sessions: application.records.map(record => ({
                id: record.sessionId,
                createdAt: record.createdAt,
            })),
            models: cards,
            ...(selectedId ? { page: await store.transcript(selectedId, beforeId) } : {}),
            locale: application.locale ?? 'en',
            configured: Boolean(key),
            active: [...runs.keys()],
            ...(selectedId ? { selectedId } : {}),
        },
    };
}

/**
 * Admit one UI command, while run ownership remains independent of renderer subscriptions.
 * @returns The committed command result and updated snapshot.
 * @param input
 */
async function handle(input: unknown): Promise<Reply> {
    const command = commandSchema.parse(input);
    if (closing) throw new Error('Backend is closing.');
    let selectedId = 'sessionId' in command ? command.sessionId : undefined;
    switch (command.type) {
        case 'create': {
            const chosen = cards.find(item => item.modelId === (command.modelId ?? card.modelId));
            if (!chosen) throw new Error('Unknown model.');
            resolveThinking(chosen, command.thinkingLevel);
            selectedId = randomUUID();
            await store.execute({
                type: 'create',
                sessionId: selectedId,
                operationId: randomUUID(),
                epoch: {
                    id: randomUUID(),
                    system: 'You are Whim, a helpful personal assistant. Reply in the language the user uses.',
                    card: chosen,
                    thinkingLevel: command.thinkingLevel ?? chosen.defaultThinkingLevel,
                },
            });
            break;
        }
        case 'send': {
            if (!key)
                throw new ApplicationError({
                    category: 'authentication',
                    retry: 'after-change',
                    outcome: 'rejected',
                });
            const prior = await store.read(command.sessionId);
            const retry = prior.some(record => record.operationId === command.operationId);
            if (!retry && (runs.has(command.sessionId) || runs.size >= 4))
                throw new ApplicationError({
                    category: 'unavailable',
                    retry: 'after-change',
                    outcome: 'rejected',
                });
            if (!command.text && !command.files?.length)
                throw new ApplicationError({
                    category: 'invalid-input',
                    retry: 'after-change',
                    outcome: 'rejected',
                });
            const frozen = foldRecords(prior).epoch.card;
            const prepared = await files.prepare(
                command.files ?? [],
                frozen,
                AbortSignal.timeout(15000)
            );
            await store.execute({
                type: 'enqueue',
                sessionId: command.sessionId,
                operationId: command.operationId,
                delivery: {
                    id: command.operationId,
                    placement: 'next-reasoning',
                    source: 'user',
                    entry: {
                        id: command.operationId,
                        role: 'user',
                        origin: 'user',
                        blocks: [
                            ...(command.text
                                ? [{ type: 'text' as const, text: command.text }]
                                : []),
                            ...prepared.blocks,
                        ],
                        ...(prepared.attachments?.length
                            ? { attachments: prepared.attachments }
                            : {}),
                    },
                },
            });
            if (retry) return snapshot(command.sessionId);
            const agent = new Agent(
                store,
                new DashScopeChat(key, undefined, undefined, frozen, (id, signal) =>
                    files.image(id, signal)
                )
            );
            const execution = { agent, completion: Promise.resolve() };
            runs.set(command.sessionId, execution);
            execution.completion = (async () => {
                try {
                    for await (const record of agent.run(command.sessionId)) {
                        parent.postMessage({ type: 'changed', sessionId: record.sessionId });
                    }
                } catch {
                    /* Durable attempt/run finalization is queried after every terminal path. */
                } finally {
                    runs.delete(command.sessionId);
                    parent.postMessage({ type: 'changed', sessionId: command.sessionId });
                }
            })();
            break;
        }
        case 'stop': {
            const run = runs.get(command.sessionId);
            if (run) await run.agent.interrupt(command.sessionId);
            break;
        }
        case 'locale':
            await store.application(command.locale);
            break;
        case 'credential':
            await vault.setPassword(command.key);
            key = command.key;
            break;
        case 'history':
        case 'snapshot':
            break;
    }
    if (command.type !== 'snapshot' && command.type !== 'history')
        parent.postMessage({ type: 'changed' });
    return snapshot(selectedId, command.type === 'history' ? command.beforeId : undefined);
}
let commands = Promise.resolve();
parent.on('message', event => {
    const envelope = z.object({ id: z.string(), command: z.unknown() }).parse(event.data);
    commands = commands.then(async () => {
        if (envelope.command === 'shutdown') {
            closing = true;
            await Promise.allSettled(
                [...runs.entries()].map(([id, run]) => run.agent.interrupt(id))
            );
            await Promise.all([...runs.values()].map(run => run.completion));
            await store.close();
            parent.postMessage({ id: envelope.id, shutdown: true });
            process.exit(0);
        }
        let reply: Reply;
        try {
            reply = await handle(envelope.command);
        } catch (error) {
            reply = {
                ok: false,
                failure:
                    error instanceof ApplicationError
                        ? error.failure
                        : { category: 'internal', retry: 'never', outcome: 'unknown' },
            };
        }
        parent.postMessage({ id: envelope.id, reply: replySchema.parse(reply) });
    });
});
parent.postMessage({ type: 'ready' });
