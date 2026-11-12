import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSearchTool, format, parseFeed, queryUrl } from './search.js';

import type { ToolContext } from '@whimkit/core/plugin';

const feed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>2</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/2511.01234v2</id>
    <updated>2026-11-10T08:00:00Z</updated>
    <published>2026-11-01T08:00:00Z</published>
    <title>Tool use
      in agents</title>
    <summary>  We study tools.
    Results improve.  </summary>
    <author><name>A. Author</name></author>
    <author><name>B. Writer</name></author>
    <arxiv:comment>Accepted at XYZ</arxiv:comment>
    <link href="http://arxiv.org/abs/2511.01234v2" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/2511.01234v2" rel="related" type="application/pdf"/>
    <category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.AI" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/cs/0112017v1</id>
    <updated>2026-11-02T08:00:00Z</updated>
    <published>2026-11-02T08:00:00Z</published>
    <title>Old style id</title>
    <summary>Short.</summary>
    <author><name>C. Old</name></author>
    <link href="http://arxiv.org/abs/cs/0112017v1" rel="alternate" type="text/html"/>
    <category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
</feed>`;

describe('arXiv search', () => {
    it('parses ids, versions, authors, categories and links, including a single-entry feed', () => {
        const page = parseFeed(feed);
        assert.equal(page.total, 2);
        assert.deepEqual(
            page.papers.map(paper => [paper.id, paper.version, paper.title]),
            [
                ['2511.01234', 2, 'Tool use in agents'],
                ['cs/0112017', 1, 'Old style id'],
            ]
        );
        assert.deepEqual(page.papers[0]?.authors, ['A. Author', 'B. Writer']);
        assert.deepEqual(page.papers[0]?.categories, ['cs.CL', 'cs.AI']);
        assert.equal(page.papers[0]?.summary, 'We study tools. Results improve.');
        assert.equal(page.papers[0]?.pdfUrl, 'http://arxiv.org/pdf/2511.01234v2');
        assert.equal(page.papers[0]?.comment, 'Accepted at XYZ');
        const single = feed.replace(/<entry>[\s\S]*?<\/entry>\s*(?=<entry>)/, '');
        assert.equal(parseFeed(single).papers.length, 1);
    });

    it('marks revisions in the formatted result', () => {
        const text = format({ query: 'x' }, parseFeed(feed));
        assert.match(text, /arXiv:2511\.01234 v2 \(a revision\)/);
        assert.match(text, /arXiv:cs\/0112017 v1 \(first version\)/);
    });

    it('builds the query with a date range on the field it sorts by', () => {
        const url = queryUrl({
            query: 'cat:cs.CL',
            sort: 'updated',
            since: '2026-11-01',
            until: '2026-11-12',
            max_results: 5,
        });
        assert.equal(
            url.searchParams.get('search_query'),
            '(cat:cs.CL) AND lastUpdatedDate:[202611010000 TO 202611122359]'
        );
        assert.equal(url.searchParams.get('sortBy'), 'lastUpdatedDate');
        assert.equal(url.searchParams.get('max_results'), '5');
    });

    it('reports a rejected query and an unreachable service as errors', async () => {
        const context = { signal: new AbortController().signal } as ToolContext;
        const rejecting = createSearchTool(
            async () =>
                new Response(
                    '<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/api/errors#x</id><title>Error</title><summary>bad field</summary><updated>2026-11-12T00:00:00Z</updated><published>2026-11-12T00:00:00Z</published></entry></feed>'
                ),
            async () => undefined
        );
        assert.deepEqual(await rejecting.execute({ query: 'zz:x' }, context), {
            content: 'arXiv rejected the query: bad field',
            isError: true,
        });
        const down = createSearchTool(
            async () => {
                throw new Error('offline');
            },
            async () => undefined
        );
        assert.deepEqual(await down.execute({ query: 'x' }, context), {
            content: 'Could not reach arXiv: offline',
            isError: true,
        });
    });
});
