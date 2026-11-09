import { definePlugin } from '@whimkit/core/plugin';

// Starts the `claude` CLI in the Coding page's tmux sessions (design.md §11.4). The CLI keeps its own
// installation, sign-in, and settings on the host it runs on.
export default definePlugin({
    activate(context) {
        context.coding.registerAgent({
            id: `${context.pluginId}#claude-code`,
            name: 'agent.name',
            command: ['claude'],
        });
    },
});
