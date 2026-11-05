import { definePlugin } from '@whimkit/core/plugin';

import { createDecisionAdapter, credentialSchema, credentialTypeId } from './system-one.js';

export default definePlugin({
    activate(context) {
        context.credentials.registerType({ id: credentialTypeId, schema: credentialSchema });
        context.models.registerAdapter(createDecisionAdapter());
    },
});
