import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
    BasicTracerProvider,
    InMemorySpanExporter,
    SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { SqliteStore } from '@whimkit/core/runtime';

import { card } from '../../../test/card.mjs';
import { Agent } from '../dist/index.js';

test('agent, model, and commit spans retain parentage across yields without exporting content', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const manager = new AsyncLocalStorageContextManager().enable();
    trace.setGlobalTracerProvider(provider);
    context.setGlobalContextManager(manager);
    const directory = await mkdtemp(join(tmpdir(), 'whim-tracing-'));
    const store = await SqliteStore.open(join(directory, 'journal.sqlite'));
    const modelParents = [];
    try {
        await store.execute({
            type: 'create',
            sessionId: 'session',
            operationId: 'create',
            epoch: { id: 'epoch', system: 'PRIVATE SYSTEM', card },
        });
        await store.execute({
            type: 'enqueue',
            sessionId: 'session',
            operationId: 'input',
            delivery: {
                id: 'input',
                source: 'user',
                placement: 'next-reasoning',
                entry: {
                    id: 'entry',
                    role: 'user',
                    origin: 'user',
                    blocks: [{ type: 'text', text: 'PRIVATE INPUT' }],
                },
            },
        });
        const agent = new Agent(store, {
            card,
            estimateTokens: async () => 1,
            async *generate() {
                modelParents.push(trace.getSpan(context.active())?.spanContext().spanId);
                yield { type: 'text', text: 'PRIVATE OUTPUT' };
                modelParents.push(trace.getSpan(context.active())?.spanContext().spanId);
                yield { type: 'completed', usage: {} };
            },
        });
        for await (const record of agent.run('session')) {
            assert.ok(record.id);
            assert.equal(trace.getSpan(context.active()), undefined);
        }
        await provider.forceFlush();
        const spans = exporter.getFinishedSpans();
        const root = spans.find(span => span.name === 'agent.run');
        const model = spans.find(span => span.name === 'model.attempt');
        assert.ok(root && model);
        assert.equal(model.parentSpanContext.spanId, root.spanContext().spanId);
        assert.deepEqual(modelParents, [model.spanContext().spanId, model.spanContext().spanId]);
        assert.equal(spans.filter(span => span.name === 'agent.commit').length, 6);
        assert.equal(
            spans.every(span => span.spanContext().traceId === root.spanContext().traceId),
            true
        );
        assert.equal(
            JSON.stringify(
                spans.map(span => ({
                    attributes: span.attributes,
                    events: span.events,
                    status: span.status,
                }))
            ).includes('PRIVATE'),
            false
        );
    } finally {
        await store.close();
        await provider.shutdown();
        context.disable();
        trace.disable();
        manager.disable();
        await rm(directory, { recursive: true, force: true });
    }
});
