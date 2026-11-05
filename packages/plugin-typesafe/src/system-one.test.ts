import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApplicationError } from '@whimkit/core/contracts';

import { adapterId, createDecisionAdapter, credentialTypeId } from './system-one.js';

import type { DecisionCard } from '@whimkit/core/contracts';
import type { DecisionRequest } from '@whimkit/core/plugin';

/**
 * A fetch answering every request with one response and recording the requests.
 * @param status HTTP status.
 * @param body JSON body.
 * @returns The transport and recorded requests.
 */
function fakeFetch(status: number, body: unknown) {
    const requests: { url: string; body: unknown; authorization: string | null }[] = [];
    const transport = (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({
            url: String(url),
            body: JSON.parse(String(init?.body)),
            authorization: new Headers(init?.headers).get('authorization'),
        });
        return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
    return { transport, requests };
}

const card: DecisionCard = {
    id: 'typesafe/jev',
    revision: 1,
    kind: 'decision',
    adapter: adapterId,
    model: 'jev-latest',
    name: 'Jev',
    options: {},
};

const request: DecisionRequest = {
    state: '{"tool":"Bash"}',
    questions: {
        verdict: {
            type: 'choice',
            instructions: 'Review the call.',
            options: { allow: 'Fine.', ask: 'Unsure.', deny: 'Harmful.' },
        },
    },
};

/**
 * Open a session over a transport.
 * @param transport The fake transport.
 * @param baseUrl Optional base URL in the credential.
 * @returns The session.
 */
function open(transport: typeof fetch, baseUrl?: string) {
    return createDecisionAdapter(transport).open({
        card,
        credential: {
            id: 'k',
            typeId: credentialTypeId,
            values: { apiKey: 'ts-key', ...(baseUrl ? { baseUrl } : {}) },
        },
    });
}

describe('System One adapter', () => {
    it('sends a choice question and returns the validated answer with usage', async () => {
        const { transport, requests } = fakeFetch(200, {
            model: 'jev-1.13.0',
            answers: {
                verdict: {
                    type: 'choice',
                    choice: 'allow',
                    confidence: 0.91,
                    probabilities: { allow: 0.91, ask: 0.06, deny: 0.03 },
                },
            },
            usage: { input_tokens: 312, output_tokens: 48 },
        });
        const result = await open(transport).decide(request, new AbortController().signal);
        assert.deepEqual(requests, [
            {
                url: 'https://api.typesafe.ai/v1/systemone',
                authorization: 'Bearer ts-key',
                body: {
                    model: 'jev-latest',
                    state: '{"tool":"Bash"}',
                    questions: {
                        verdict: {
                            type: 'choice',
                            instructions: 'Review the call.',
                            criteria: { allow: 'Fine.', ask: 'Unsure.', deny: 'Harmful.' },
                        },
                    },
                },
            },
        ]);
        assert.deepEqual(result, {
            answers: {
                verdict: {
                    type: 'choice',
                    choice: 'allow',
                    confidence: 0.91,
                    probabilities: { allow: 0.91, ask: 0.06, deny: 0.03 },
                },
            },
            usage: { inputTokens: 312, outputTokens: 48, totalTokens: 360 },
        });
    });

    it('uses a base URL from the credential', async () => {
        const { transport, requests } = fakeFetch(200, {
            model: 'jev',
            answers: {
                verdict: { type: 'choice', choice: 'ask', confidence: 0.5, probabilities: {} },
            },
            usage: { input_tokens: 1, output_tokens: 1 },
        });
        await open(transport, 'http://127.0.0.1:9/gateway/').decide(
            request,
            new AbortController().signal
        );
        assert.equal(requests[0]?.url, 'http://127.0.0.1:9/gateway/v1/systemone');
    });

    it('rejects an answer that is not one of the choices', async () => {
        const { transport } = fakeFetch(200, {
            model: 'jev',
            answers: { verdict: { type: 'noul', noul: 0.9 } },
            usage: { input_tokens: 1, output_tokens: 1 },
        });
        await assert.rejects(
            open(transport).decide(request, new AbortController().signal),
            (error: unknown) =>
                error instanceof ApplicationError && error.failure.category === 'protocol'
        );
    });

    it('maps documented and standard HTTP failures', async () => {
        const failures = [];
        for (const [status, body] of [
            [400, { detail: 'Too many questions.' }],
            [422, { detail: [{ loc: ['body', 'state'], msg: 'Field required', type: 'missing' }] }],
            [401, { detail: 'Invalid API key.' }],
            [429, {}],
        ] as const) {
            const error = await open(fakeFetch(status, body).transport)
                .decide(request, new AbortController().signal)
                .catch((caught: unknown) => caught);
            assert.ok(error instanceof ApplicationError);
            failures.push(error.failure);
        }
        assert.deepEqual(failures, [
            {
                category: 'invalid-request',
                retry: { kind: 'never' },
                outcome: 'rejected',
                detail: { provider: 'typesafe', status: 400, message: 'Too many questions.' },
            },
            {
                category: 'invalid-request',
                retry: { kind: 'never' },
                outcome: 'rejected',
                detail: { provider: 'typesafe', status: 422, message: 'Field required' },
            },
            {
                category: 'authentication',
                retry: { kind: 'after-change', change: 'credential' },
                outcome: 'rejected',
                detail: { provider: 'typesafe', status: 401, message: 'Invalid API key.' },
            },
            {
                category: 'rate-limited',
                retry: { kind: 'backoff' },
                outcome: 'rejected',
                detail: { provider: 'typesafe', status: 429 },
            },
        ]);
    });
});
