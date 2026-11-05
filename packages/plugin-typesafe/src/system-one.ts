import { ApplicationError, boundText } from '@whimkit/core/contracts';
import { z } from 'zod';

import type { DecisionCard, Failure } from '@whimkit/core/contracts';
import type {
    ChoiceAnswer,
    DecisionAdapter,
    DecisionRequest,
    DecisionResult,
    DecisionSession,
    ResolvedCredential,
} from '@whimkit/core/plugin';

export const pluginId = '@whimkit/plugin-typesafe';
export const credentialTypeId = `${pluginId}#api-key`;
export const adapterId = `${pluginId}#system-one`;
const provider = 'typesafe';
const defaultBaseUrl = 'https://api.typesafe.ai';

export const credentialSchema = {
    type: 'object',
    title: 'TypeSafe API key',
    required: ['apiKey'],
    additionalProperties: false,
    properties: {
        apiKey: {
            type: 'string',
            title: 'API key',
            writeOnly: true,
            format: 'password',
            minLength: 1,
        },
        baseUrl: {
            type: 'string',
            title: 'Base URL',
            format: 'uri',
            description: `Leave empty for ${defaultBaseUrl}.`,
        },
    },
} as const;

const credentialValues = z.object({
    apiKey: z.string().min(1),
    baseUrl: z.string().url().optional(),
});

const choiceAnswerSchema = z.looseObject({
    type: z.literal('choice'),
    choice: z.string(),
    confidence: z.number().min(0).max(1),
    probabilities: z.record(z.string(), z.number()),
});

/** `SystemOneResponse` from the OpenAPI contract; answers of other types are rejected. */
const responseSchema = z.looseObject({
    model: z.string(),
    answers: z.record(z.string(), z.looseObject({ type: z.string() })),
    usage: z.looseObject({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
    }),
});

/**
 * The provider's explanation from a 400 (`{ detail: string | object }`) or 422
 * (`{ detail: [{ msg }] }`) body.
 * @param body Parsed JSON body.
 * @returns The message, if any.
 */
function detailOf(body: unknown): string | undefined {
    if (body === null || typeof body !== 'object' || !('detail' in body)) return undefined;
    const { detail } = body;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
        const messages = detail.flatMap(item =>
            item && typeof item === 'object' && 'msg' in item && typeof item.msg === 'string'
                ? [item.msg]
                : []
        );
        return messages.length ? messages.join('; ') : undefined;
    }
    return JSON.stringify(detail);
}

/**
 * Map an HTTP failure. The contract documents 400 and 422; authentication, rate limits, and
 * server errors follow standard HTTP meaning.
 * @param status HTTP status.
 * @param body Parsed body, if JSON.
 * @returns The failure.
 */
export function httpFailure(status: number, body: unknown): Failure {
    const message = boundText(detailOf(body));
    const detail = { provider, status, ...(message ? { message } : {}) };
    const make = (category: Failure['category'], retry: Failure['retry']): Failure => ({
        category,
        retry,
        outcome: status >= 500 ? 'unknown' : 'rejected',
        detail,
    });
    if (status === 401)
        return make('authentication', { kind: 'after-change', change: 'credential' });
    if (status === 403) return make('permission', { kind: 'after-change', change: 'account' });
    if (status === 404)
        return make('model-unavailable', { kind: 'after-change', change: 'configuration' });
    if (status === 429) return make('rate-limited', { kind: 'backoff' });
    if (status >= 500) return make('overloaded', { kind: 'backoff' });
    return make('invalid-request', { kind: 'never' });
}

/**
 * A protocol failure for a response outside the contract.
 * @param message What was wrong.
 * @returns The error.
 */
function protocolError(message: string): ApplicationError {
    return new ApplicationError({
        category: 'protocol',
        retry: { kind: 'never' },
        outcome: 'unknown',
        detail: { provider, message },
    });
}

/** One card bound to one credential. */
class SystemOneSession implements DecisionSession {
    readonly #endpoint: string;
    readonly #apiKey: string;

    /**
     * Bind a card and credential.
     * @param card The Decision card.
     * @param credential The decrypted credential.
     * @param transport The fetch implementation.
     */
    constructor(
        private readonly card: DecisionCard,
        credential: ResolvedCredential,
        private readonly transport: typeof fetch
    ) {
        const values = credentialValues.safeParse(credential.values);
        if (!values.success)
            throw new ApplicationError({
                category: 'authentication',
                retry: { kind: 'after-change', change: 'credential' },
                outcome: 'rejected',
                detail: { provider, message: 'The TypeSafe credential has no API key.' },
            });
        this.#apiKey = values.data.apiKey;
        this.#endpoint = `${(values.data.baseUrl ?? defaultBaseUrl).replace(/\/+$/, '')}/v1/systemone`;
    }

    /**
     * Ask the questions in one `POST /v1/systemone` call.
     * @param request State and choice questions.
     * @param signal Cancels the call.
     * @returns One validated answer per question and the reported usage.
     */
    async decide(request: DecisionRequest, signal: AbortSignal): Promise<DecisionResult> {
        const questions = Object.fromEntries(
            Object.entries(request.questions).map(([name, question]) => [
                name,
                { type: 'choice', instructions: question.instructions, criteria: question.options },
            ])
        );
        let response: Response;
        try {
            response = await this.transport(this.#endpoint, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${this.#apiKey}`,
                    'content-type': 'application/json',
                },
                body: JSON.stringify({ model: this.card.model, state: request.state, questions }),
                signal,
            });
        } catch (error) {
            throw new ApplicationError(
                signal.aborted
                    ? {
                          category: 'cancelled',
                          retry: { kind: 'never' },
                          outcome: 'unknown',
                          detail: { provider, message: 'The request was cancelled.' },
                      }
                    : {
                          category: 'transport',
                          retry: { kind: 'backoff' },
                          outcome: 'unknown',
                          detail: { provider, message: 'TypeSafe could not be reached.' },
                      },
                { cause: error }
            );
        }
        const text = await response.text();
        let body: unknown;
        try {
            body = JSON.parse(text);
        } catch {
            body = undefined;
        }
        if (!response.ok) throw new ApplicationError(httpFailure(response.status, body));
        const parsed = responseSchema.safeParse(body);
        if (!parsed.success) throw protocolError('TypeSafe returned a response outside its API.');
        const answers: Record<string, ChoiceAnswer> = {};
        for (const [name, question] of Object.entries(request.questions)) {
            const answer = choiceAnswerSchema.safeParse(parsed.data.answers[name]);
            if (!answer.success || !(answer.data.choice in question.options))
                throw protocolError(`TypeSafe did not answer ${name} with one of its choices.`);
            answers[name] = {
                type: 'choice',
                choice: answer.data.choice,
                confidence: answer.data.confidence,
                probabilities: answer.data.probabilities,
            };
        }
        const { input_tokens: inputTokens, output_tokens: outputTokens } = parsed.data.usage;
        return {
            answers,
            usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
        };
    }
}

/**
 * The System One adapter.
 * @param transport The fetch implementation; injectable for tests.
 * @returns The adapter.
 */
export function createDecisionAdapter(transport: typeof fetch = fetch): DecisionAdapter {
    return {
        id: adapterId,
        kind: 'decision',
        credentialTypes: [credentialTypeId],
        optionsSchema: { type: 'object', additionalProperties: false },
        open: ({ card, credential }) => new SystemOneSession(card, credential, transport),
    };
}
