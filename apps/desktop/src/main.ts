import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, ipcMain, utilityProcess } from 'electron';
import { z } from 'zod';

import { commandSchema, replySchema } from './contracts.js';

import type { Reply } from './contracts.js';

if (process.platform !== 'darwin') throw new Error('Whim supports macOS only.');
if (process.env.WHIM_DATA_DIR) app.setPath('userData', process.env.WHIM_DATA_DIR);
const directory = fileURLToPath(new URL('.', import.meta.url));
const pending = new Map<
    string,
    { resolve: (reply: Reply) => void; reject: (error: Error) => void }
>();
let window: BrowserWindow | null = null;
let quitting = false;
let available = true;
/** Start after module evaluation so Electron can emit its ready event. */
async function start(): Promise<void> {
    await app.whenReady();
    const backend = utilityProcess.fork(
        join(directory, 'backend.js'),
        [join(app.getPath('userData'), 'whim.sqlite')],
        { serviceName: 'Whim Backend', stdio: 'pipe' }
    );
    backend.stderr?.on('data', chunk => process.stderr.write(chunk));
    const ready = new Promise<void>((resolve, reject) => {
        backend.on('message', (input: unknown) => {
            const message = z
                .object({
                    type: z.string().optional(),
                    id: z.string().optional(),
                    reply: replySchema.optional(),
                    shutdown: z.boolean().optional(),
                })
                .parse(input);
            if (message.type === 'ready') resolve();
            if (message.type === 'changed') window?.webContents.send('whim:changed');
            if (message.id && message.reply) {
                pending.get(message.id)?.resolve(message.reply);
                pending.delete(message.id);
            }
        });
        backend.once('exit', () => {
            available = false;
            const failure = new Error('Backend unavailable. Restart Whim to recover.');
            for (const request of pending.values()) request.reject(failure);
            pending.clear();
            reject(failure);
            window?.webContents.send('whim:changed');
        });
    });
    await ready;
    ipcMain.handle('whim:command', async (event, input: unknown) => {
        if (
            event.sender !== window?.webContents ||
            event.senderFrame !== window.webContents.mainFrame ||
            quitting ||
            !available
        )
            throw new Error('Unavailable client.');
        const command = commandSchema.parse(input);
        const id = randomUUID();
        return new Promise<Reply>((resolve, reject) => {
            pending.set(id, { resolve, reject });
            backend.postMessage({ id, command });
        });
    });

    /** Create the isolated local renderer; navigation never grants Node access. */
    async function createWindow(): Promise<void> {
        window = new BrowserWindow({
            width: 1120,
            height: 780,
            minWidth: 680,
            minHeight: 540,
            title: 'Whim',
            backgroundColor: '#ffffff',
            webPreferences: {
                preload: join(directory, 'preload.cjs'),
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
            },
        });
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-navigate', event => event.preventDefault());
        window.on('closed', () => {
            window = null;
        });
        await window.loadFile(join(directory, 'renderer/index.html'));
    }
    await createWindow();
    app.on('activate', () => {
        if (!window && !quitting) void createWindow();
    });
    app.on('window-all-closed', () => app.quit());
    app.on('before-quit', event => {
        if (quitting) return;
        event.preventDefault();
        quitting = true;
        const timer = setTimeout(() => {
            backend.kill();
            app.exit(0);
        }, 5000);
        backend.once('exit', () => {
            clearTimeout(timer);
            app.exit(0);
        });
        backend.postMessage({ id: randomUUID(), command: 'shutdown' });
    });
}
void start().catch(() => {
    process.stderr.write('Whim startup failed.\n');
    app.exit(1);
});
