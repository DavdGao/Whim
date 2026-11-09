import { z } from 'zod';

export const failureCategories = [
    'authentication',
    'permission',
    'account',
    'rate-limited',
    'overloaded',
    'context-limit',
    /** The reply reached the output token limit and was cut off. */
    'output-limit',
    'content-filtered',
    'invalid-request',
    'model-unavailable',
    'transport',
    'timeout',
    'protocol',
    'cancelled',
    'internal',
] as const;

export const retrySchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('never') }),
    z.strictObject({
        kind: z.literal('after-change'),
        change: z.enum(['credential', 'input', 'configuration', 'account']),
    }),
    z.strictObject({
        kind: z.literal('backoff'),
        afterMs: z.number().int().nonnegative().optional(),
    }),
]);

/** Provider evidence shown to the user; bounded so a hostile body cannot flood records. */
export const failureDetailSchema = z.strictObject({
    provider: z.string().min(1).max(100),
    status: z.number().int().optional(),
    code: z.string().max(200).optional(),
    message: z.string().max(2000).optional(),
    requestId: z.string().max(200).optional(),
});

export const failureSchema = z.strictObject({
    category: z.enum(failureCategories),
    retry: retrySchema,
    outcome: z.enum(['rejected', 'partial', 'unknown']),
    detail: failureDetailSchema.optional(),
});

export type Failure = z.infer<typeof failureSchema>;
export type FailureCategory = Failure['category'];
export type FailureDetail = z.infer<typeof failureDetailSchema>;

/** Error carrying a normalized failure across adapter, runtime, and IPC boundaries. */
export class ApplicationError extends Error {
    readonly failure: Failure;

    /**
     * Wrap a normalized failure, preserving the original cause.
     * @param failure The normalized failure.
     * @param options Standard error options carrying the cause.
     */
    constructor(failure: Failure, options?: ErrorOptions) {
        super(failure.detail?.message ?? failure.category, options);
        this.name = 'ApplicationError';
        this.failure = failureSchema.parse(failure);
    }
}

/**
 * Truncate provider text to the detail bound instead of rejecting it.
 * @param text Provider-supplied text.
 * @param limit Maximum length.
 * @returns The bounded text, or undefined when absent.
 */
export function boundText(text: unknown, limit = 2000): string | undefined {
    if (typeof text !== 'string' || text.length === 0) return undefined;
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
