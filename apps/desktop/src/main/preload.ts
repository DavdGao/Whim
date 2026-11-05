/// <reference lib="dom" />
import { contextBridge, ipcRenderer } from 'electron';

// Sandboxed preloads cannot import application modules, so envelope checks are inlined here and
// repeated with full schemas in the Renderer client.
type Listener = (event: unknown) => void;

let port: MessagePort | undefined;
let next = 0;
const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
>();
const listeners = new Set<Listener>();
const statusListeners = new Set<(status: string) => void>();
const queued: { id: number; method: string; params: unknown }[] = [];

ipcRenderer.on('whim:port', event => {
    const [received] = event.ports;
    if (!received) return;
    port?.close();
    port = received;
    port.onmessage = message => {
        const data: unknown = message.data;
        if (typeof data !== 'object' || data === null || !('kind' in data)) return;
        if (data.kind === 'event' && 'event' in data)
            for (const listener of listeners) listener(data.event);
        else if (data.kind === 'response' && 'id' in data && typeof data.id === 'number') {
            const request = pending.get(data.id);
            if (!request) return;
            pending.delete(data.id);
            if ('ok' in data && data.ok === true)
                request.resolve('value' in data ? data.value : null);
            else
                request.reject(
                    'error' in data ? data.error : { code: 'internal', message: 'Unknown error.' }
                );
        }
    };
    port.start();
    // A new port means Backend (re)connected: resend queued requests and refresh state.
    const resent = new Set<number>();
    for (const request of queued.splice(0)) {
        resent.add(request.id);
        port.postMessage({ kind: 'request', ...request });
    }
    // Requests sent on a previous port will never be answered.
    for (const [id, request] of pending)
        if (!resent.has(id)) {
            pending.delete(id);
            request.reject({ code: 'unavailable', message: 'Backend restarted.' });
        }
    for (const listener of statusListeners) listener('connected');
    for (const listener of listeners) listener({ type: 'state' });
});

ipcRenderer.on('whim:backend', (_event, status: unknown) => {
    for (const listener of statusListeners) listener(String(status));
});

contextBridge.exposeInMainWorld('whim', {
    invoke(method: string, params: unknown): Promise<unknown> {
        const id = next++;
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            if (port) port.postMessage({ kind: 'request', id, method, params });
            else queued.push({ id, method, params });
        });
    },
    onEvent(listener: Listener): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },
    async chooseDirectory(): Promise<string | null> {
        const path: unknown = await ipcRenderer.invoke('whim:choose-directory');
        return typeof path === 'string' ? path : null;
    },
    async openDirectory(path: string): Promise<boolean> {
        return (await ipcRenderer.invoke('whim:open-directory', path)) === true;
    },
    onStatus(listener: (status: string) => void): () => void {
        statusListeners.add(listener);
        return () => statusListeners.delete(listener);
    },
});
