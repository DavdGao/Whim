import { defineTool } from '@whimkit/core/plugin';
import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';

import type { ToolDefinition } from '@whimkit/core/plugin';

// arXiv's public query API (https://info.arxiv.org/help/api/user-manual.html): Atom over HTTPS,
// no sign-in. arXiv asks clients to wait three seconds between calls.

export const endpoint = 'https://export.arxiv.org/api/query';
const timeoutMs = 30_000;
const minGapMs = 3000;
const maxSummaryChars = 800;
const userAgent = 'Whim (https://github.com/DavdGao/Whim)';

export interface SearchInput {
    readonly query: string;
    readonly sort?: 'submitted' | 'updated' | 'relevance';
    readonly since?: string;
    readonly until?: string;
    readonly max_results?: number;
    readonly start?: number;
}

/** One paper as the model sees it. */
export interface Paper {
    readonly id: string;
    readonly version: number;
    readonly title: string;
    readonly authors: readonly string[];
    readonly categories: readonly string[];
    readonly published: string;
    readonly updated: string;
    readonly summary: string;
    readonly absUrl: string;
    readonly pdfUrl: string | undefined;
    readonly comment: string | undefined;
    readonly journal: string | undefined;
}

export interface Page {
    readonly total: number;
    readonly start: number;
    readonly papers: readonly Paper[];
}

const text = z.union([z.string(), z.number()]).transform(String);
const many = <T extends z.ZodType>(item: T) =>
    z.union([item, z.array(item)]).transform(value => (Array.isArray(value) ? value : [value]));

const feedSchema = z.looseObject({
    feed: z.looseObject({
        'opensearch:totalResults': z.coerce.number().optional(),
        'opensearch:startIndex': z.coerce.number().optional(),
        entry: many(
            z.looseObject({
                id: text,
                title: text,
                summary: text.optional(),
                published: text,
                updated: text,
                author: many(z.looseObject({ name: text })).optional(),
                category: many(z.looseObject({ '@_term': text })).optional(),
                link: many(
                    z.looseObject({
                        '@_href': text,
                        '@_rel': text.optional(),
                        '@_title': text.optional(),
                    })
                ).optional(),
                'arxiv:comment': text.optional(),
                'arxiv:journal_ref': text.optional(),
            })
        ).optional(),
    }),
});

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    parseAttributeValue: false,
    isArray: () => false,
});

/**
 * Collapse whitespace the way arXiv wraps titles and abstracts.
 * @param value Raw text.
 * @returns One line.
 */
const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim();

/**
 * Parse the Atom feed the query API returns.
 * @param xml The response body.
 * @returns The page, or throws when it is not an arXiv feed.
 */
export function parseFeed(xml: string): Page {
    const { feed } = feedSchema.parse(parser.parse(xml));
    const papers = (feed.entry ?? []).map((entry): Paper => {
        // `http://arxiv.org/abs/2511.01234v2` → id and version.
        const match = /abs\/(.+?)(?:v(\d+))?$/.exec(entry.id);
        const links = entry.link ?? [];
        const summary = oneLine(entry.summary ?? '');
        return {
            id: match?.[1] ?? entry.id,
            version: Number(match?.[2] ?? 1),
            title: oneLine(entry.title),
            authors: (entry.author ?? []).map(author => oneLine(author.name)),
            categories: (entry.category ?? []).map(category => category['@_term']),
            published: entry.published,
            updated: entry.updated,
            summary:
                summary.length > maxSummaryChars
                    ? `${summary.slice(0, maxSummaryChars)}…`
                    : summary,
            absUrl: links.find(link => link['@_rel'] === 'alternate')?.['@_href'] ?? entry.id,
            pdfUrl: links.find(link => link['@_title'] === 'pdf')?.['@_href'],
            comment: entry['arxiv:comment'] ? oneLine(entry['arxiv:comment']) : undefined,
            journal: entry['arxiv:journal_ref'] ? oneLine(entry['arxiv:journal_ref']) : undefined,
        };
    });
    return {
        total: feed['opensearch:totalResults'] ?? papers.length,
        start: feed['opensearch:startIndex'] ?? 0,
        papers,
    };
}

/**
 * A date as arXiv's range syntax wants it.
 * @param date `YYYY-MM-DD`.
 * @param end Whether it closes a range (end of that day).
 * @returns `YYYYMMDDHHMM`.
 */
function stamp(date: string, end: boolean): string {
    return `${date.replaceAll('-', '')}${end ? '2359' : '0000'}`;
}

/**
 * The query URL for a search.
 * @param input The tool input.
 * @returns The URL.
 */
export function queryUrl(input: SearchInput): URL {
    const sort = input.sort ?? 'submitted';
    let query = input.query.trim();
    if (input.since || input.until) {
        const field = sort === 'updated' ? 'lastUpdatedDate' : 'submittedDate';
        const range = `${field}:[${input.since ? stamp(input.since, false) : '000001010000'} TO ${input.until ? stamp(input.until, true) : '999912312359'}]`;
        query = `(${query}) AND ${range}`;
    }
    const url = new URL(endpoint);
    url.searchParams.set('search_query', query);
    url.searchParams.set('start', String(input.start ?? 0));
    url.searchParams.set('max_results', String(input.max_results ?? 20));
    url.searchParams.set(
        'sortBy',
        sort === 'relevance'
            ? 'relevance'
            : sort === 'updated'
              ? 'lastUpdatedDate'
              : 'submittedDate'
    );
    url.searchParams.set('sortOrder', 'descending');
    return url;
}

/**
 * Format a page for the model.
 * @param input The search.
 * @param page The result.
 * @returns The text.
 */
export function format(input: SearchInput, page: Page): string {
    if (page.papers.length === 0) return `No papers match "${input.query}".`;
    const lines = [
        `${page.total} papers match "${input.query}"; showing ${page.start + 1}–${page.start + page.papers.length}, sorted by ${input.sort ?? 'submitted'} date, newest first.`,
    ];
    page.papers.forEach((paper, index) => {
        lines.push(
            '',
            `${page.start + index + 1}. ${paper.title}`,
            `   arXiv:${paper.id} v${paper.version}${paper.version > 1 ? ' (a revision)' : ' (first version)'} · ${paper.categories.join(', ')}`,
            `   ${paper.authors.join(', ')}`,
            `   submitted ${paper.published.slice(0, 10)}, updated ${paper.updated.slice(0, 10)}`,
            `   ${paper.absUrl}${paper.pdfUrl ? ` · ${paper.pdfUrl}` : ''}`
        );
        if (paper.comment) lines.push(`   comment: ${paper.comment}`);
        if (paper.journal) lines.push(`   journal: ${paper.journal}`);
        lines.push(`   ${paper.summary}`);
    });
    return lines.join('\n');
}

let nextAt = 0;
/**
 * Wait so calls keep arXiv's requested spacing within this process.
 * @param signal Aborts the wait.
 */
async function throttle(signal: AbortSignal): Promise<void> {
    const at = Math.max(nextAt, Date.now());
    nextAt = at + minGapMs;
    const wait = at - Date.now();
    if (wait <= 0) return;
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, wait);
        signal.addEventListener(
            'abort',
            () => {
                clearTimeout(timer);
                reject(signal.reason);
            },
            { once: true }
        );
    });
}

const dateSchema = {
    type: 'string',
    pattern: '^\\d{4}-\\d{2}-\\d{2}$',
} as const;

/**
 * The ArxivSearch tool.
 * @param transport The fetch implementation; injectable for tests.
 * @param pause Waits between calls; injectable for tests.
 * @returns The tool.
 */
export function createSearchTool(
    transport: typeof fetch = fetch,
    pause: (signal: AbortSignal) => Promise<void> = throttle
): ToolDefinition<SearchInput> {
    return defineTool<SearchInput>({
        name: 'ArxivSearch',
        description:
            "Search arXiv papers. Returns each paper's id, version, categories, authors, dates, links and abstract, newest first by default.\n\n" +
            'The query uses arXiv syntax: fields `all:`, `ti:` (title), `au:` (author), `abs:` (abstract) and `cat:` (category such as cs.CL), combined with AND, OR and ANDNOT, phrases in double quotes, e.g. `cat:cs.CL AND ti:"tool use"`. ' +
            'Use `since`/`until` to bound the date. A version above 1 means the paper was revised; compare the dates to tell a new paper from a revised one. ' +
            'Results are abstracts only; read the paper itself with WebFetch on its PDF link.',
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 500,
                    description:
                        'The arXiv search query, for example `cat:cs.AI AND abs:"agent memory"`.',
                },
                sort: {
                    type: 'string',
                    enum: ['submitted', 'updated', 'relevance'],
                    description:
                        'Order of results (default submitted, newest first); `updated` also lists revisions.',
                },
                since: {
                    ...dateSchema,
                    description:
                        'Only papers submitted (or updated, when sort is updated) on or after this date, YYYY-MM-DD.',
                },
                until: {
                    ...dateSchema,
                    description: 'Only papers up to and including this date, YYYY-MM-DD.',
                },
                max_results: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 50,
                    description: 'How many papers to return (default 20).',
                },
                start: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 2000,
                    description: 'Offset of the first result, to page through more (default 0).',
                },
            },
            required: ['query'],
            additionalProperties: false,
        },
        readOnly: true,
        concurrencySafe: false,
        needsWorkspace: false,
        access: () => [{ kind: 'network', url: endpoint }],
        async execute(input, context) {
            const signal = AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)]);
            await pause(context.signal);
            let response: Response;
            try {
                response = await transport(queryUrl(input), {
                    headers: { 'User-Agent': userAgent },
                    signal,
                });
            } catch (error) {
                if (context.signal.aborted) throw error;
                return {
                    content: `Could not reach arXiv: ${error instanceof Error ? error.message : String(error)}`,
                    isError: true,
                };
            }
            const body = await response.text();
            if (!response.ok)
                return {
                    content:
                        response.status === 429 || response.status === 503
                            ? `arXiv is limiting requests (HTTP ${response.status}); wait a minute before searching again.`
                            : `arXiv returned HTTP ${response.status}.`,
                    isError: true,
                };
            let page: Page;
            try {
                page = parseFeed(body);
            } catch {
                // The API reports a bad query as an Atom entry titled "Error".
                const detail = /<summary>([\s\S]*?)<\/summary>/.exec(body)?.[1]?.trim();
                return {
                    content: detail
                        ? `arXiv rejected the query: ${oneLine(detail)}`
                        : 'arXiv returned a response Whim could not read.',
                    isError: true,
                };
            }
            if (page.papers.length === 1 && page.papers[0]?.title === 'Error')
                return {
                    content: `arXiv rejected the query: ${page.papers[0].summary}`,
                    isError: true,
                };
            return { content: format(input, page) };
        },
    });
}
