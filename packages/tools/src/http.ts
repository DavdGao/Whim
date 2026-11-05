/** The subset of `fetch` the tools use; injectable for tests. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Options shared by both tools. */
export interface WebToolsOptions {
    readonly fetch: FetchLike;
    /** Application version used in the User-Agent. */
    readonly version: string;
    /** Per-request timeout; defaults to 30 seconds. */
    readonly timeoutMs?: number;
}

export const defaultTimeoutMs = 30_000;

/** Hard cap on bytes read from one response body. */
export const maxBodyBytes = 5 * 1024 * 1024;

/**
 * Build the User-Agent header value.
 * @param version Application version.
 * @returns The header value.
 */
export function userAgent(version: string): string {
    return `Whim/${version} (+https://github.com/DavdGao/Whim)`;
}

/**
 * Combine the caller's cancellation with the request timeout.
 * @param signal Cancellation from the tool context.
 * @param timeoutMs Timeout in milliseconds.
 * @returns A signal aborted by either.
 */
export function requestSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
    return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

/**
 * Whether a failure came from the timeout rather than the caller's cancellation.
 * @param error The thrown value.
 * @param signal The caller's signal.
 * @returns True for a timeout.
 */
export function isTimeout(error: unknown, signal: AbortSignal): boolean {
    return !signal.aborted && error instanceof Error && error.name === 'TimeoutError';
}

/**
 * Read a response body up to a byte cap, cancelling the stream beyond it.
 * @param response The response.
 * @param cap Maximum bytes to keep.
 * @returns The bytes read and whether more data was available.
 */
export async function readCapped(
    response: Response,
    cap: number
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
    if (!response.body) return { bytes: new Uint8Array(0), truncated: false };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let truncated = false;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (size + value.byteLength > cap) {
                chunks.push(value.subarray(0, cap - size));
                size = cap;
                truncated = true;
                break;
            }
            chunks.push(value);
            size += value.byteLength;
        }
    } finally {
        if (truncated) await reader.cancel();
        reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return { bytes, truncated };
}

/**
 * Decode bytes using the charset from a content type, falling back to UTF-8.
 * @param bytes Body bytes.
 * @param contentType The Content-Type header value.
 * @returns Decoded text.
 */
export function decodeBody(bytes: Uint8Array, contentType: string): string {
    const charset = /charset=["']?([^;"'\s]+)/i.exec(contentType)?.[1] ?? 'utf-8';
    try {
        return new TextDecoder(charset).decode(bytes);
    } catch {
        // Unknown charset label: UTF-8 is the best-effort default.
        return new TextDecoder('utf-8').decode(bytes);
    }
}
