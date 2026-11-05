import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApplicationError } from '../contracts/failure.js';

import { ChatReviewer, DecisionReviewer } from './review.js';

import type { ReviewRequest } from './review.js';
import type {
    ChatEvent,
    ChatRequest,
    ChatSession,
    DecisionRequest,
    DecisionResult,
} from '../plugin/index.js';

const request: ReviewRequest = {
    tool: { name: 'Bash', description: 'Run a command.' },
    input: { command: 'rm -rf build' },
    access: [{ kind: 'execute', command: 'rm -rf build' }],
    workspace: '/work',
    requests: ['clean the build'],
};

/**
 * A chat session replaying fixed events and recording its requests.
 * @param events What the stream yields.
 * @returns The session and its requests.
 */
function chat(events: ChatEvent[]) {
    const requests: ChatRequest[] = [];
    const session: ChatSession = {
        inputBudget: () => 10_000,
        async *stream(chatRequest) {
            requests.push(chatRequest);
            yield* events;
        },
    };
    return { session, requests };
}

const thinking = { levels: ['low', 'off', 'high'], default: 'high' };

describe('ChatReviewer', () => {
    it('reads the decision from the decide call, with thinking off', async () => {
        const { session, requests } = chat([
            { type: 'text-delta', text: 'Looks fine.' },
            {
                type: 'tool-call',
                callId: 'c',
                name: 'decide',
                arguments: '{"decision":"allow","reason":"The user asked to clean the build."}',
            },
            { type: 'completed', usage: { inputTokens: 300, outputTokens: 20 } },
        ]);
        const reviewer = new ChatReviewer('chat/card', thinking, async () => session);
        assert.deepEqual(await reviewer.review(request, new AbortController().signal), {
            outcome: 'allow',
            reason: 'The user asked to clean the build.',
            usage: { inputTokens: 300, outputTokens: 20 },
        });
        assert.equal(requests[0]?.thinking, 'off');
        assert.deepEqual(
            requests[0]?.tools.map(tool => tool.name),
            ['decide']
        );
        assert.deepEqual(requests[0]?.messages, [
            {
                role: 'user',
                blocks: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            {
                                requests: ['clean the build'],
                                workspace: '/work',
                                tool: request.tool,
                                input: request.input,
                                access: request.access,
                            },
                            null,
                            2
                        ),
                    },
                ],
            },
        ]);
    });

    it('never takes a decision from text', async () => {
        const { session } = chat([
            { type: 'text-delta', text: '{"decision":"allow","reason":"ok"}' },
            { type: 'completed', usage: {} },
        ]);
        const reviewer = new ChatReviewer('chat/card', undefined, async () => session);
        await assert.rejects(
            reviewer.review(request, new AbortController().signal),
            (error: unknown) =>
                error instanceof ApplicationError && error.failure.category === 'protocol'
        );
    });

    it('rejects arguments outside the schema', async () => {
        const { session } = chat([
            {
                type: 'tool-call',
                callId: 'c',
                name: 'decide',
                arguments: '{"decision":"maybe","reason":"?"}',
            },
            { type: 'completed', usage: {} },
        ]);
        const reviewer = new ChatReviewer('chat/card', undefined, async () => session);
        await assert.rejects(
            reviewer.review(request, new AbortController().signal),
            /invalid decision/
        );
    });
});

/**
 * A decision session with a fixed answer that records its requests.
 * @param result The answer.
 * @returns The opener and the requests.
 */
function decision(result: DecisionResult) {
    const requests: DecisionRequest[] = [];
    return {
        open: async () => ({
            decide: async (decisionRequest: DecisionRequest) => {
                requests.push(decisionRequest);
                return result;
            },
        }),
        requests,
    };
}

describe('DecisionReviewer', () => {
    it('takes a confident choice and asks one question with the three options', async () => {
        const { open, requests } = decision({
            answers: {
                verdict: {
                    type: 'choice',
                    choice: 'deny',
                    confidence: 0.92,
                    probabilities: { allow: 0.03, ask: 0.05, deny: 0.92 },
                },
            },
            usage: { inputTokens: 250 },
        });
        const review = await new DecisionReviewer('decision/card', open).review(
            request,
            new AbortController().signal
        );
        assert.deepEqual(review, {
            outcome: 'deny',
            reason: 'The decision model chose deny with 92% confidence.',
            usage: { inputTokens: 250 },
        });
        const question = requests[0]?.questions.verdict;
        assert.deepEqual(Object.keys(question?.options ?? {}), ['allow', 'ask', 'deny']);
    });

    it('leaves an unconfident choice to the user', async () => {
        const { open } = decision({
            answers: {
                verdict: {
                    type: 'choice',
                    choice: 'allow',
                    confidence: 0.6,
                    probabilities: { allow: 0.6, ask: 0.3, deny: 0.1 },
                },
            },
            usage: {},
        });
        const review = await new DecisionReviewer('decision/card', open).review(
            request,
            new AbortController().signal
        );
        assert.deepEqual(review, {
            outcome: 'ask',
            reason: 'The decision model leaned toward allow with only 60% confidence.',
            usage: {},
        });
    });
});
