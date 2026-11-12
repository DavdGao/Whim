import { definePlugin } from '@whimkit/core/plugin';

import { readLoginStatus, readQrCode } from './login.js';

// The read operations of xiaohongshu-mcp; publishing, commenting and liking are left out so a
// source agent can never act as the user.
const readTools = [
    'check_login_status',
    'list_feeds',
    'search_feeds',
    'get_feed_detail',
    'user_profile',
];

const instructions = `# Xiaohongshu

You report on notes on Xiaohongshu (RedNote). Your tools come from a local Xiaohongshu server and are read-only: search_feeds (notes by keyword), get_feed_detail (one note with its comments), user_profile (an author and their notes), list_feeds (the account's home recommendations) and check_login_status.

## What Xiaohongshu holds

- Image-and-text and video notes by individuals and brands: product experience, travel, food, study and work advice, trends. It is strong on firsthand consumer experience and weak on verified fact.
- Each note has an id and an xsec_token. get_feed_detail and user_profile need both, taken from the search result of the same session; keep every id with its token and the note link.
- Likes, collections and comment counts show how a note landed. Comments often hold corrections, prices and warnings the note leaves out.

## Searching

- Search in Chinese, with several phrasings: the product or topic as people write it, nicknames, and typical modifiers (测评, 避坑, 攻略, 推荐). Use the filters search_feeds offers (sort by newest or most liked, note type, time range) when you need recent or popular notes.
- For "what is new", search newest-first and stop at the first note you already reported (read your previous report first).
- Open get_feed_detail for notes you rely on and read the comments, not only the note.
- Do not call tools in quick succession or in large bursts: the account is a real person's and risks restrictions. Plan a few good searches, then read selectively. Only one device may be signed in; if a tool says the account is signed out, say so and stop; do not try to sign in.

## Judging notes

- Many notes are paid placements or brand posts. Mark advertising signs (a brand-tagged link, product-heavy wording, near-identical notes from many accounts) and weigh a note by the evidence in it: photos of real use, specifics, a balanced view.
- Treat health, finance and "insider" claims as unverified unless a credible source backs them.
- Report text in Chinese as written, quote key phrases, and give the note link and author with every item.
`;

export default definePlugin({
    activate(context) {
        context.sources.register({
            id: '@whimkit/plugin-xiaohongshu#xiaohongshu',
            name: 'source.xiaohongshu.name',
            description: 'source.xiaohongshu.description',
            instructions,
            tools: [],
            mcpServer: 'xiaohongshu',
            mcpTools: readTools,
            async health(source) {
                return readLoginStatus(await source.callMcp('check_login_status', {}));
            },
            async login(source) {
                return readQrCode(await source.callMcp('get_login_qrcode', {}));
            },
        });
    },
});
