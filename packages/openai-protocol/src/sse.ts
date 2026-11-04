export interface SseEvent {
    readonly event?: string;
    readonly data: string;
}

/** Raised when the byte stream violates the SSE framing limits. */
export class SseFramingError extends Error {
    /**
     * Describe the framing problem.
     * @param message What went wrong.
     */
    constructor(message: string) {
        super(message);
        this.name = 'SseFramingError';
    }
}

/**
 * Decode a Server-Sent Events byte stream into events. An unterminated trailing event is
 * discarded, as the SSE specification requires; callers decide whether EOF is complete.
 * @param body The response body.
 * @param maxFrameBytes Upper bound for one buffered event.
 * @yields Events in order.
 */
export async function* readSse(
    body: ReadableStream<Uint8Array>,
    maxFrameBytes = 4 * 1024 * 1024
): AsyncGenerator<SseEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let data: string[] = [];
    let event: string | undefined;
    try {
        while (true) {
            const { done, value } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });
            let newline: number;
            while ((newline = buffer.search(/\r\n|\r|\n/)) >= 0) {
                // A trailing CR may be the first half of a CRLF split across chunks.
                if (!done && newline === buffer.length - 1 && buffer.endsWith('\r')) break;
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + (buffer.startsWith('\r\n', newline) ? 2 : 1));
                if (line === '') {
                    if (data.length) yield { ...(event ? { event } : {}), data: data.join('\n') };
                    data = [];
                    event = undefined;
                    continue;
                }
                if (line.startsWith(':')) continue;
                const colon = line.indexOf(':');
                const field = colon < 0 ? line : line.slice(0, colon);
                const raw = colon < 0 ? '' : line.slice(colon + 1);
                const fieldValue = raw.startsWith(' ') ? raw.slice(1) : raw;
                if (field === 'data') data.push(fieldValue);
                else if (field === 'event') event = fieldValue;
            }
            if (buffer.length + data.reduce((sum, item) => sum + item.length, 0) > maxFrameBytes)
                throw new SseFramingError('An event exceeded the frame size limit.');
            if (done) return;
        }
    } finally {
        reader.releaseLock();
    }
}
