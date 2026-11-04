import { definePlugin } from '@whimkit/core/plugin';

import { createWebTools } from './tools.js';

export default definePlugin({
    activate(context) {
        const { webFetch } = createWebTools({ fetch, version: context.version });
        context.tools.register(webFetch);
    },
});
