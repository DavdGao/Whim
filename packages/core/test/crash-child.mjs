import process from 'node:process';

import { card } from '../../../test/card.mjs';
import { SqliteStore } from '../dist/store.js';

const store = await SqliteStore.open(process.argv[2]);
const run = { sessionId: 'crash-session', runId: 'run', generation: 'generation' };
await store.execute({
    type: 'create',
    sessionId: run.sessionId,
    operationId: 'create',
    epoch: { id: 'epoch', system: 'System', card },
});
await store.execute({
    type: 'enqueue',
    sessionId: run.sessionId,
    operationId: 'input',
    delivery: {
        id: 'input',
        source: 'user',
        placement: 'next-reasoning',
        entry: {
            id: 'user',
            role: 'user',
            origin: 'user',
            blocks: [{ type: 'text', text: 'Hello' }],
        },
    },
});
await store.execute({ type: 'start', ...run, operationId: 'start' });
await store.execute({
    type: 'prepare',
    ...run,
    operationId: 'prepare',
    planId: 'plan',
    expectedContextVersion: '1',
    deliveryIds: ['input'],
    estimatedTokens: 1,
});
await store.execute({
    type: 'attempt',
    ...run,
    operationId: 'attempt',
    planId: 'plan',
    attemptId: 'attempt',
    messageId: 'reply',
    purpose: 'chat',
});
await store.execute({
    type: 'chunk',
    ...run,
    operationId: 'chunk',
    attemptId: 'attempt',
    index: 0,
    text: 'Persisted before SIGKILL.',
});
process.send?.('ready');
