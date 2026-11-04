import { z } from 'zod';

import type { TokenUsage } from '@whimkit/models';

export const failureSchema = z.strictObject({
    category: z.enum([
        'rate-limited',
        'quota-exhausted',
        'unavailable',
        'authentication',
        'permission',
        'invalid-input',
        'context-limit',
        'cancelled',
        'transport',
        'protocol',
        'internal',
    ]),
    outcome: z.enum(['rejected', 'unknown', 'partial']),
    retry: z.enum(['never', 'after-change', 'backoff', 'reconcile']),
    retryAfterMs: z.number().nonnegative().optional(),
    status: z.number().int().optional(),
});
export type Failure = z.infer<typeof failureSchema>;

/** Carry sanitized application failures without exposing provider response bodies. */
export class ApplicationError extends Error {
    /**
     * Construct a validated application failure.
     * @param failure
     * @param options
     * @param usage
     */
    constructor(
        public readonly failure: Failure,
        options?: ErrorOptions,
        public readonly usage?: TokenUsage
    ) {
        super(failure.category, options);
        failureSchema.parse(failure);
        this.name = 'ApplicationError';
    }
}
