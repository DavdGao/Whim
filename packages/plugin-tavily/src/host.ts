import { definePlugin } from '@whimkit/core/plugin';

import { createSearchTool, credentialSchema, credentialTypeId } from './search.js';

export default definePlugin({
    activate(context) {
        context.credentials.registerType({ id: credentialTypeId, schema: credentialSchema });
        context.tools.register(createSearchTool());
    },
});
