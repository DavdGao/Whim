import { definePlugin } from '@whimkit/core/plugin';

import { createTools, credentialSchema, credentialTypeId } from './api.js';

const instructions = `# Reddit

You report on Reddit. Your tools are RedditListing (a subreddit by hot, new or top), RedditSearch (words, site-wide or in one subreddit) and RedditComments (the discussion under a post).

## What Reddit holds

- Communities (subreddits) with their own rules and culture. The same topic reads differently in different communities; always name the subreddit.
- Posts are ranked by votes. Score is votes net of downvotes at the time you read it; upvote_ratio shows how contested a post is. Hot favours recent activity, top favours a time window (day, week, month, year, all), new is plain chronology.
- The real value is often in the comments: corrections, experience reports and counter-arguments. Read the comments of any post you rely on.
- You only see public subreddits. Removed or deleted posts show as [deleted]; do not infer from them.

## Searching and following

- To follow a community, list new for completeness and hot or top (week) for what mattered; compare them.
- For a topic, search site-wide with several phrasings, then look in the two or three subreddits that dominate the results.
- For "what is new", list new and stop at the first post you already reported (read your previous report first). Keep each post's id and link.
- Continue with after only while posts stay relevant. Reddit's search is shallow and misses things; say so when a negative result matters.

## Judging posts

- High score is popularity, not correctness. Distinguish firsthand accounts, secondhand summaries and speculation, and mark unverified claims.
- Link posts point to the source; open it with WebFetch when it matters. Marketing, self-promotion and astroturfing are common; note when an author mostly posts about one product.
- NSFW posts are marked; leave them out unless the user's task is about them.
`;

export default definePlugin({
    activate(context) {
        context.credentials.registerType({ id: credentialTypeId, schema: credentialSchema });
        const { listing, search, comments } = createTools();
        context.tools.register(listing);
        context.tools.register(search);
        context.tools.register(comments);
        context.sources.register({
            id: '@whimkit/plugin-reddit#reddit',
            name: 'source.reddit.name',
            description: 'source.reddit.description',
            instructions,
            tools: ['RedditListing', 'RedditSearch', 'RedditComments'],
            credentialType: credentialTypeId,
        });
    },
});
