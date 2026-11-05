import { stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    app,
    BrowserWindow,
    dialog,
    ipcMain,
    MessageChannelMain,
    safeStorage,
    shell,
    utilityProcess,
} from 'electron';

import type { UtilityProcess } from 'electron';

const here = dirname(fileURLToPath(import.meta.url));
let backend: UtilityProcess | undefined;
let backendReady = false;
let window: BrowserWindow | undefined;
let quitting = false;
let restarts = 0;

/**
 * Answer a Backend cipher request with safeStorage, which only Main can use.
 * @param message The request.
 * @param message.id Correlation id.
 * @param message.op Encrypt or decrypt.
 * @param message.data Plaintext or ciphertext.
 */
function handleCipher(message: { id: number; op: string; data: unknown }): void {
    try {
        if (!safeStorage.isEncryptionAvailable())
            throw new Error('Secure storage is not available.');
        const value =
            message.op === 'encrypt' && typeof message.data === 'string'
                ? new Uint8Array(safeStorage.encryptString(message.data))
                : message.op === 'decrypt' && message.data instanceof Uint8Array
                  ? safeStorage.decryptString(Buffer.from(message.data))
                  : undefined;
        if (value === undefined) throw new Error('Invalid cipher request.');
        backend?.postMessage({ type: 'cipher', id: message.id, ok: true, value });
    } catch (error) {
        backend?.postMessage({
            type: 'cipher',
            id: message.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

/** Give the current window a fresh port to Backend. */
function connectRenderer(): void {
    if (!backend || !backendReady || !window) return;
    const { port1, port2 } = new MessageChannelMain();
    backend.postMessage({ type: 'renderer' }, [port1]);
    window.webContents.postMessage('whim:port', null, [port2]);
}

/** Start Backend and restart it with backoff after unexpected exits. */
function startBackend(): void {
    backendReady = false;
    const child = utilityProcess.fork(join(here, 'backend.js'), [], {
        serviceName: 'Whim Backend',
        stdio: 'inherit',
    });
    backend = child;
    child.on('message', (message: unknown) => {
        if (typeof message !== 'object' || message === null || !('type' in message)) return;
        if (
            message.type === 'cipher' &&
            'id' in message &&
            'op' in message &&
            typeof message.id === 'number'
        )
            handleCipher({
                id: message.id,
                op: String(message.op),
                data: 'data' in message ? message.data : undefined,
            });
        else if (message.type === 'ready') {
            backendReady = true;
            restarts = 0;
            connectRenderer();
        } else if (message.type === 'fatal') {
            console.error(
                'Backend failed to start:',
                'message' in message ? message.message : message
            );
            window?.webContents.send('whim:backend', 'failed');
        }
    });
    child.on('exit', code => {
        if (backend === child) backend = undefined;
        if (quitting) return;
        console.error(`Backend exited with code ${code}; restarting.`);
        window?.webContents.send('whim:backend', 'restarting');
        const delay = Math.min(30_000, 500 * 2 ** restarts++);
        setTimeout(startBackend, delay);
    });
    child.postMessage({
        type: 'init',
        userData: app.getPath('userData'),
        version: app.getVersion(),
    });
}

/** Create the main window. */
function createWindow(): void {
    window = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 720,
        minHeight: 480,
        title: 'Whim',
        show: false,
        // Immersive chrome: no native title bar; traffic lights sit inside the app's top bar.
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 16, y: 14 },
        backgroundColor: '#fafafa',
        webPreferences: {
            preload: join(here, 'preload.cjs'),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    window.once('ready-to-show', () => window?.show());
    window.webContents.on('did-finish-load', connectRenderer);
    window.on('closed', () => {
        window = undefined;
    });
    // Links never open Electron windows: web links go to the system browser, anything else is
    // refused. In-page navigation away from the app is blocked the same way.
    window.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
        return { action: 'deny' };
    });
    window.webContents.on('will-navigate', event => event.preventDefault());
    void window.loadFile(join(here, 'renderer', 'index.html'));
}

// Automated tests on hosts without a keychain opt into Electron's plaintext fallback explicitly.
if (process.env.WHIM_TEST_PLAINTEXT_SECRETS === '1') {
    void app.whenReady().then(() => safeStorage.setUsePlainTextEncryption(true));
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (window?.isMinimized()) window.restore();
        window?.focus();
    });
    app.whenReady().then(() => {
        // Folder picker for a chat's workspace; only the application window may ask.
        ipcMain.handle('whim:choose-directory', async event => {
            if (!window || event.sender !== window.webContents) return null;
            const result = await dialog.showOpenDialog(window, {
                properties: ['openDirectory', 'createDirectory'],
            });
            return result.canceled ? null : (result.filePaths[0] ?? null);
        });
        // Shows a chat's folder in the file manager. Only absolute paths to existing directories
        // are opened, so the window cannot launch files or applications through it.
        ipcMain.handle('whim:open-directory', async (event, path: unknown) => {
            if (!window || event.sender !== window.webContents) return false;
            if (typeof path !== 'string' || !isAbsolute(path)) return false;
            const info = await stat(path).catch(() => undefined);
            if (!info?.isDirectory()) return false;
            return (await shell.openPath(path)) === '';
        });
        startBackend();
        createWindow();
        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    });
    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });
    app.on('before-quit', event => {
        if (quitting || !backend) return;
        event.preventDefault();
        quitting = true;
        const child = backend;
        const timer = setTimeout(() => child.kill(), 8000);
        child.once('exit', () => {
            clearTimeout(timer);
            app.quit();
        });
        child.postMessage({ type: 'shutdown' });
    });
}
