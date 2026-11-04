import { definePlugin } from '@whimkit/core/plugin';

import { bashTool } from './bash.js';
import { editTool } from './edit.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { readTool } from './read.js';
import { writeTool } from './write.js';

export default definePlugin({
    activate(context) {
        context.tools.register(bashTool);
        context.tools.register(readTool);
        context.tools.register(writeTool);
        context.tools.register(editTool);
        context.tools.register(globTool);
        context.tools.register(grepTool);
    },
});
