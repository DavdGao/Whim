import { defineTool } from '@whimkit/core/plugin';
import { NodeHtmlMarkdown } from 'node-html-markdown';
import { parse } from 'node-html-parser';

import {
    decodeBody,
    defaultTimeoutMs,
    isTimeout,
    maxBodyBytes,
    readCapped,
    requestSignal,
    userAgent,
} from './http.js';

import type { WebToolsOptions } from './http.js';
import type { ToolDefinition, ToolOutput } from '@whimkit/core/plugin';

interface WebFetchInput {
    url: string;
    prompt?: string;
}

const maxRedirects = 5;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const converter = new NodeHtmlMarkdown({ ignore: ['script', 'style', 'noscript', 'svg'] });

/** Outcome of following same-host redirects. */
type Hop =
    | { readonly kind: 'response'; readonly response: Response; readonly url: URL }
    | { readonly kind: 'cross-host'; readonly target: URL; readonly status: number }
    | { readonly kind: 'error'; readonly message: string };

/**
 * Classify a content type as HTML, plain text, or unreadable.
 * @param contentType The media type without parameters, lower case.
 * @returns The handling category.
 */
function categorize(contentType: string): 'html' | 'text' | 'binary' {
    if (contentType === 'text/html' || contentType === 'application/xhtml+xml') return 'html';
    if (
        contentType === '' ||
        contentType.startsWith('text/') ||
        contentType === 'application/json' ||
        contentType === 'application/xml' ||
        contentType === 'application/javascript' ||
        contentType.endsWith('+json') ||
        contentType.endsWith('+xml')
    ) {
        return 'text';
    }
    return 'binary';
}

/**
 * Issue one request without following redirects.
 * @param options Tool options.
 * @param url Target.
 * @param signal Combined cancellation and timeout signal.
 * @returns The response.
 */
function send(options: WebToolsOptions, url: URL, signal: AbortSignal): Promise<Response> {
    return options.fetch(url, {
        redirect: 'manual',
        signal,
        headers: {
            'User-Agent': userAgent(options.version),
            Accept: 'text/html, text/markdown, text/plain, application/json;q=0.9, */*;q=0.1',
        },
    });
}

/**
 * Fetch a URL, following same-host redirects and stopping at a host change.
 * @param options Tool options.
 * @param start Initial URL.
 * @param signal Combined signal.
 * @returns The final hop outcome.
 */
async function follow(options: WebToolsOptions, start: URL, signal: AbortSignal): Promise<Hop> {
    let current = start;
    for (let count = 0; count <= maxRedirects; count++) {
        const response = await send(options, current, signal);
        const location = response.headers.get('location');
        if (!redirectStatuses.has(response.status) || location === null) {
            return { kind: 'response', response, url: current };
        }
        await response.body?.cancel();
        let target: URL;
        try {
            target = new URL(location, current);
        } catch {
            return { kind: 'error', message: `Invalid redirect location: ${location}` };
        }
        if (target.protocol !== 'http:' && target.protocol !== 'https:') {
            return { kind: 'error', message: `Redirect to unsupported scheme: ${target.href}` };
        }
        if (target.hostname !== current.hostname) {
            return { kind: 'cross-host', target, status: response.status };
        }
        current = target;
    }
    return { kind: 'error', message: `Too many redirects (more than ${maxRedirects}).` };
}

/**
 * Fetch with the https-first rule for http URLs.
 * @param options Tool options.
 * @param url Requested URL.
 * @param signal Combined signal.
 * @returns The hop outcome.
 */
async function fetchWithScheme(
    options: WebToolsOptions,
    url: URL,
    signal: AbortSignal
): Promise<Hop> {
    if (url.protocol === 'https:') return follow(options, url, signal);
    const secure = new URL(url);
    secure.protocol = 'https:';
    try {
        return await follow(options, secure, signal);
    } catch (error) {
        if (signal.aborted) throw error;
        // https could not connect; fall back to the scheme the model asked for.
        return follow(options, url, signal);
    }
}

/**
 * Render a response body as text for the model.
 * @param response The final response.
 * @param focus Optional requested focus.
 * @param requested Requested URL.
 * @param finalUrl Final URL.
 * @returns The tool output.
 */
async function render(
    response: Response,
    focus: string | undefined,
    requested: string,
    finalUrl: string
): Promise<ToolOutput> {
    const rawType = response.headers.get('content-type') ?? '';
    const mediaType = (rawType.split(';')[0] ?? '').trim().toLowerCase();
    const lines = [
        `URL: ${requested}`,
        `Final URL: ${finalUrl}`,
        `Status: ${response.status}`,
        `Content-Type: ${rawType || 'unknown'}`,
    ];
    const category = categorize(mediaType);
    const { bytes, truncated } = await readCapped(response, maxBodyBytes);
    if (category === 'binary') {
        lines.push(
            `Size: ${bytes.byteLength}${truncated ? '+' : ''} bytes`,
            '',
            `This content type (${mediaType}) cannot be read as text; only its metadata is available.`
        );
        return { content: lines.join('\n'), isError: true };
    }
    if (mediaType === '' && bytes.includes(0)) {
        lines.push(
            '',
            'The response has no content type and looks binary; it cannot be read as text.'
        );
        return { content: lines.join('\n'), isError: true };
    }
    const text = decodeBody(bytes, rawType);
    let body = text;
    if (category === 'html') {
        const title = parse(text).querySelector('title')?.text.trim();
        if (title) lines.push(`Title: ${title}`);
        body = converter.translate(text);
    }
    if (truncated) lines.push(`Note: the body was truncated at ${maxBodyBytes} bytes.`);
    const head = focus ? [`Requested focus: ${focus}`, ...lines] : lines;
    return { content: `${head.join('\n')}\n\n${body}`, isError: response.status >= 400 };
}

/**
 * Create the WebFetch tool.
 * @param options Injectable transport and version.
 * @returns The tool definition.
 */
export function createFetchTool(options: WebToolsOptions): ToolDefinition<WebFetchInput> {
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    return defineTool<WebFetchInput>({
        name: 'WebFetch',
        description:
            'Fetch a web page or text resource over HTTP(S) and return its content (HTML is converted to Markdown). ' +
            'Use it to read a specific URL, for example one from WebSearch or one the user provided. ' +
            'The result starts with the requested and final URL, status and content type. ' +
            'If the server redirects to a different host the redirect is NOT followed; the result names the target ' +
            'and you may call WebFetch again with it. Same-host redirects are followed. ' +
            'Images, PDFs and other binary content cannot be read (metadata only). Bodies are capped at 5 MiB. ' +
            'The optional prompt only records what you are looking for at the top of the result; nothing is summarized.',
        inputSchema: {
            type: 'object',
            properties: {
                url: {
                    type: 'string',
                    format: 'uri',
                    description: 'The http or https URL to fetch.',
                },
                prompt: {
                    type: 'string',
                    description: 'What to look for in the page (noted in the result).',
                },
            },
            required: ['url'],
            additionalProperties: false,
        },
        readOnly: true,
        concurrencySafe: true,
        needsWorkspace: false,
        standard: 'web_fetch',
        access: input => [{ kind: 'network', url: input.url }],
        async execute(input, context) {
            let url: URL;
            try {
                url = new URL(input.url);
            } catch {
                return { content: `Invalid URL: ${input.url}`, isError: true };
            }
            if (url.protocol !== 'http:' && url.protocol !== 'https:') {
                return {
                    content: `Only http and https URLs are supported: ${input.url}`,
                    isError: true,
                };
            }
            const signal = requestSignal(context.signal, timeoutMs);
            try {
                const hop = await fetchWithScheme(options, url, signal);
                if (hop.kind === 'error') return { content: hop.message, isError: true };
                if (hop.kind === 'cross-host') {
                    return {
                        content:
                            `URL: ${input.url}\nStatus: ${hop.status}\n\n` +
                            `Redirected to a different host (${hop.target.hostname}) and not followed. ` +
                            `Call WebFetch again with this URL if you want it: ${hop.target.href}`,
                    };
                }
                return await render(hop.response, input.prompt, input.url, hop.url.href);
            } catch (error) {
                if (isTimeout(error, context.signal)) {
                    return {
                        content: `Request timed out after ${timeoutMs} ms: ${input.url}`,
                        isError: true,
                    };
                }
                throw error;
            }
        },
    });
}
