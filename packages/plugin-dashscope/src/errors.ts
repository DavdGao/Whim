import { boundText } from '@whimkit/core/contracts';

import type { Failure } from '@whimkit/core/contracts';

const provider = 'dashscope';

/**
 * Map a DashScope HTTP failure to a normalized failure (docs/providers/dashscope.md).
 * @param status HTTP status.
 * @param body Parsed error body, if any.
 * @param retryAfter The `retry-after` header.
 * @returns The failure.
 */
export function httpFailure(status: number, body: unknown, retryAfter: string | null): Failure {
    const fields = errorFields(body);
    const code = fields.code?.toLowerCase() ?? '';
    const message = fields.message?.toLowerCase() ?? '';
    const detail = {
        provider,
        status,
        ...(fields.code ? { code: boundText(fields.code, 200) } : {}),
        ...(fields.message ? { message: boundText(fields.message) } : {}),
        ...(fields.requestId ? { requestId: boundText(fields.requestId, 200) } : {}),
    };
    const afterMs = parseRetryAfter(retryAfter);
    const backoff = { kind: 'backoff' as const, ...(afterMs !== undefined ? { afterMs } : {}) };
    const make = (category: Failure['category'], retry: Failure['retry']): Failure => ({
        category,
        retry,
        outcome: status >= 500 ? 'unknown' : 'rejected',
        detail,
    });
    if (status === 401 || code === 'invalidapikey' || code === 'invalid_api_key')
        return make('authentication', { kind: 'after-change', change: 'credential' });
    if (code === 'arrearage') return make('account', { kind: 'after-change', change: 'account' });
    if (status === 403)
        return make('permission', { kind: 'after-change', change: 'configuration' });
    if (status === 429 || code.startsWith('throttling') || code === 'insufficient_quota')
        return make('rate-limited', backoff);
    if (code === 'datainspectionfailed' || code === 'data_inspection_failed')
        return make('content-filtered', { kind: 'after-change', change: 'input' });
    if (status === 404 || code === 'modelnotfound' || code === 'model_not_found')
        return make('model-unavailable', { kind: 'after-change', change: 'configuration' });
    if (status === 400 && (message.includes('input length') || message.includes('context')))
        return make('context-limit', { kind: 'after-change', change: 'input' });
    if (status >= 500) return make('overloaded', backoff);
    if (status >= 400) return make('invalid-request', { kind: 'never' });
    return make('protocol', { kind: 'never' });
}

/**
 * Read error fields from either the native `{ code, message, request_id }` shape or the
 * OpenAI-style `{ error: { code, message } }` shape.
 * @param body Parsed JSON body.
 * @returns The fields found.
 */
function errorFields(body: unknown): { code?: string; message?: string; requestId?: string } {
    if (body === null || typeof body !== 'object') return {};
    const record = body as Record<string, unknown>;
    const nested =
        record.error !== null && typeof record.error === 'object'
            ? (record.error as Record<string, unknown>)
            : record;
    const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
    const code = text(nested.code) ?? text(record.code);
    const message = text(nested.message) ?? text(record.message);
    const requestId = text(record.request_id) ?? text(record.requestId);
    return {
        ...(code ? { code } : {}),
        ...(message ? { message } : {}),
        ...(requestId ? { requestId } : {}),
    };
}

/**
 * Parse a `retry-after` header in seconds or HTTP-date form.
 * @param value The header value.
 * @returns Delay in milliseconds, or undefined.
 */
function parseRetryAfter(value: string | null): number | undefined {
    if (!value) return undefined;
    const delay = /^\d+(\.\d+)?$/.test(value)
        ? Number(value) * 1000
        : Date.parse(value) - Date.now();
    return Number.isFinite(delay) ? Math.max(0, Math.round(delay)) : undefined;
}

/**
 * Map an in-stream terminal failure.
 * @param kind The terminal event kind.
 * @param published Whether output was already streamed.
 * @param code Provider code.
 * @param message Provider message.
 * @returns The failure.
 */
export function streamFailure(
    kind: 'failed' | 'incomplete' | 'error' | 'eof',
    published: boolean,
    code?: string,
    message?: string
): Failure {
    const detail = {
        provider,
        ...(code ? { code: boundText(code, 200) } : {}),
        ...(message ? { message: boundText(message) } : {}),
    };
    const outcome = published ? ('partial' as const) : ('unknown' as const);
    if (kind === 'eof')
        return { category: 'transport', retry: { kind: 'backoff' }, outcome, detail };
    if (kind === 'incomplete')
        return {
            category: code === 'max_output_tokens' ? 'context-limit' : 'protocol',
            retry: { kind: 'never' },
            outcome,
            detail,
        };
    const lower = code?.toLowerCase() ?? '';
    if (lower.startsWith('throttling') || lower.includes('rate'))
        return { category: 'rate-limited', retry: { kind: 'backoff' }, outcome, detail };
    if (lower.includes('internal') || lower.includes('server') || lower.includes('unavailable'))
        return { category: 'overloaded', retry: { kind: 'backoff' }, outcome, detail };
    return { category: 'protocol', retry: { kind: 'never' }, outcome, detail };
}
