import { contextBridge, ipcRenderer } from 'electron';

import { commandSchema, replySchema } from './contracts.js';

import type { DesktopClient } from './contracts.js';

const client: DesktopClient = {
    invoke: async command =>
        replySchema.parse(await ipcRenderer.invoke('whim:command', commandSchema.parse(command))),
    subscribe: listener => {
        const handler = () => listener();
        ipcRenderer.on('whim:changed', handler);
        return () => ipcRenderer.removeListener('whim:changed', handler);
    },
};
contextBridge.exposeInMainWorld('whim', client);
