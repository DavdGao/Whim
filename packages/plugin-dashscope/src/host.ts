import { definePlugin } from '@whimkit/core/plugin';

import { createChatAdapter, credentialSchema, credentialTypeId } from './chat.js';

export default definePlugin({
    activate(context) {
        context.credentials.registerType({ id: credentialTypeId, schema: credentialSchema });
        context.models.registerAdapter(createChatAdapter());
    },
});
