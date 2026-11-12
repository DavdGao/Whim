import { definePlugin } from '@whimkit/core/plugin';

import { createSearchTool, endpoint } from './search.js';

const instructions = `# arXiv

You report on papers on arXiv. Your tool is ArxivSearch; open a paper's PDF with WebFetch when the abstract is not enough to judge it.

## What arXiv holds

- Preprints, mostly not yet peer reviewed. Say so for claims that rest on one paper, and look for the code, a later version, or independent results before calling something established.
- A paper has an id such as 2511.01234 and versions v1, v2, …. A first appearance is v1; a higher version is a revision. In reports always give the id with its version, and say whether a paper is new or revised.
- Categories are the subject classes (cs.CL, cs.LG, stat.ML …). A paper has one primary and any number of cross-listed categories. Search a category with \`cat:\`, a topic with \`abs:\` or \`ti:\`, an author with \`au:\`.

## Searching

- For a topic, run several queries rather than one: the topic's usual names and abbreviations, its neighbours, and the main authors and labs known for it, each in the likely categories. Compare the result lists; papers that appear under several phrasings matter more.
- For "what is new", search with \`since\` set to the date of your previous report on the topic (read it first), sorted by submitted date. Run it once more sorted by updated date to find revisions of older papers.
- Page with \`start\` when a query returns more than one page of relevant results; stop when results turn irrelevant.
- The tool waits between calls, as arXiv asks; plan queries instead of retrying the same one.

## Judging papers

- Prefer what the abstract states as results (numbers, comparisons, released code) over claims of novelty. Check the comment field for acceptance (for example a conference) and the journal field for publication.
- Treat very similar titles by the same authors as one line of work; report them together and name the differences.
- Papers claiming large gains with no code, no baselines, or only self-chosen benchmarks are to be flagged as unverified.
- Find the code (a link in the abstract or comment, or the authors' repository) before saying a result is reproducible.
`;

export default definePlugin({
    activate(context) {
        context.tools.register(createSearchTool());
        context.sources.register({
            id: '@whimkit/plugin-arxiv#arxiv',
            name: 'source.arxiv.name',
            description: 'source.arxiv.description',
            instructions,
            tools: ['ArxivSearch'],
            async health({ signal }) {
                try {
                    const response = await fetch(
                        `${endpoint}?search_query=all:test&max_results=1`,
                        {
                            signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
                        }
                    );
                    return response.ok
                        ? { state: 'ready' }
                        : {
                              state: 'unavailable',
                              detail: `arXiv returned HTTP ${response.status}.`,
                          };
                } catch (error) {
                    return {
                        state: 'unavailable',
                        detail: `Could not reach arXiv: ${error instanceof Error ? error.message : String(error)}`,
                    };
                }
            },
        });
    },
});
