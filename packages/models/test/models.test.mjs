import assert from 'node:assert/strict';
import test from 'node:test';

import { card } from '../../../test/card.mjs';
import { chatEventSchema, chatModelCardSchema, validateTextCard } from '../dist/index.js';

test('cards preserve concrete MIME routes, unknown limits, and reject monetary fields', () => {
    assert.deepEqual(validateTextCard(card), card);
    assert.equal(chatModelCardSchema.safeParse({ ...card, pricing: 1 }).success, false);
    assert.equal(
        chatModelCardSchema.safeParse({
            ...card,
            inputMedia: { 'image/*': { routes: [{ delivery: 'url', maxBytes: null }] } },
        }).success,
        false
    );
    assert.throws(() => validateTextCard({ ...card, inputMedia: {} }));
    const pdf = {
        ...card,
        inputMedia: {
            ...card.inputMedia,
            'application/pdf': {
                routes: [{ delivery: 'file-id', maxBytes: 1048576, maxPages: 20 }],
            },
        },
    };
    assert.deepEqual(chatModelCardSchema.parse(pdf), pdf);
});

test('completion requires an explicit terminal event and leaves unreported usage unknown', () => {
    assert.deepEqual(chatEventSchema.parse({ type: 'completed', usage: {} }), {
        type: 'completed',
        usage: {},
    });
    assert.equal(chatEventSchema.safeParse({ type: 'completed' }).success, false);
    assert.equal(
        chatEventSchema.safeParse({ type: 'completed', usage: { inputTokens: -1 } }).success,
        false
    );
    assert.equal(chatEventSchema.safeParse({ type: 'text', text: '' }).success, false);
});

test('input MIME keys are an allowlist and tool capabilities are booleans', () => {
    assert.equal(
        chatModelCardSchema.safeParse({
            ...card,
            inputMedia: { 'application/pdf': { support: 'unsupported' } },
        }).success,
        false
    );
    assert.equal(
        chatModelCardSchema.safeParse({
            ...card,
            capabilities: { ...card.capabilities, webSearch: 'unknown' },
        }).success,
        false
    );
    assert.deepEqual(validateTextCard(card).inputMedia, {
        'text/plain': { routes: [{ delivery: 'text', maxBytes: 100000 }] },
    });
});
