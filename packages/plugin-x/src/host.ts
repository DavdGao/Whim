import { definePlugin } from '@whimkit/core/plugin';

import {
    createSearchTool,
    createUserPostsTool,
    credentialSchema,
    credentialTypeId,
} from './api.js';

const instructions = `# X

You report on posts on X. Your tools are XSearch (recent posts by topic, last 7 days only) and XUserPosts (one account's latest posts).

## What X holds

- Short posts, replies, reposts and quotes by people and organisations, fast and unfiltered. It is a signal of what people are saying, not a record of what is true.
- A post's counts (likes, reposts, replies, views) are a snapshot; engagement is mostly in the first hours, so compare posts of similar age.
- Search cannot see beyond 7 days. Do not claim something was not discussed earlier because search is empty.

## Searching

- For a topic, run several queries: the names and hashtags people actually use, the abbreviations, and the main accounts (\`from:\`). Add \`-is:retweet\` and \`lang:\` to cut noise.
- For "what is new", set \`since\` to the date of your previous report and read it first so you do not repeat items.
- Follow chosen accounts with XUserPosts; leave replies and reposts out unless the replies are the point.
- Continue with page_token only while results stay relevant. Calls cost the user API credit, so avoid repeating the same query.

## Judging posts

- Say who posted: an official account, a person with a track record, or an anonymous account. Treat anonymous claims and screenshots as unverified.
- A viral post is not a verified one. Look for the primary source (a paper, a repository, an announcement) and link it; open it with WebFetch when it matters.
- Quote posts reaching opposite conclusions together. Keep the post link for every item you report.
`;

export default definePlugin({
    activate(context) {
        context.credentials.registerType({ id: credentialTypeId, schema: credentialSchema });
        context.tools.register(createSearchTool());
        context.tools.register(createUserPostsTool());
        context.sources.register({
            id: '@whimkit/plugin-x#x',
            name: 'source.x.name',
            description: 'source.x.description',
            instructions,
            tools: ['XSearch', 'XUserPosts'],
            credentialType: credentialTypeId,
        });
    },
});
