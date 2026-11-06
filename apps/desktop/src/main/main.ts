import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    app,
    BrowserWindow,
    dialog,
    ipcMain,
    Menu,
    MessageChannelMain,
    Notification,
    powerMonitor,
    powerSaveBlocker,
    protocol,
    safeStorage,
    shell,
    Tray,
    utilityProcess,
} from 'electron';

import { activitySchema, attentionSchema, pluginClientsSchema } from '../shared/main-protocol.js';

import { mainText } from './strings.js';

import type { Activity, Attention } from '../shared/main-protocol.js';
import type { MenuItemConstructorOptions, UtilityProcess } from 'electron';

const here = dirname(fileURLToPath(import.meta.url));
let backend: UtilityProcess | undefined;
let backendReady = false;
let window: BrowserWindow | undefined;
let quitting = false;
let restarts = 0;
/** The latest snapshot from Backend (design.md §4.1); empty while Backend is down. */
let activity: Activity = { type: 'activity', locale: 'en', running: [] };
let tray: Tray | undefined;
let powerBlocker: number | undefined;
/** A chat to show once a newly created window has loaded. */
let pendingSession: string | undefined;
/** Quit was confirmed, or needs no confirmation (system shutdown). */
let quitConfirmed = false;
let confirmingQuit = false;
/** Shown notifications, kept so their click handlers are not collected. */
const notifications = new Set<Notification>();
/** Client directories of active plugins, by plugin id (design.md §5.7). */
let pluginRoots = new Map<string, string>();

/** Files a plugin client directory may serve, by extension. */
const pluginFileTypes: Readonly<Record<string, string>> = {
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
};

// Plugin client files load as ES modules from the file:// page, which needs a standard,
// secure, CORS-enabled scheme.
protocol.registerSchemesAsPrivileged([
    {
        scheme: 'whim-plugin',
        privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
]);

/**
 * Serve `whim-plugin://plugins/<pluginId>/<path>` from that plugin's client directory only.
 * @param request The request.
 * @returns The file, or 404 for anything outside an active plugin's client directory.
 */
async function servePluginFile(request: Request): Promise<Response> {
    const notFound = new Response(null, { status: 404 });
    const url = new URL(request.url);
    const [, encodedId, ...segments] = url.pathname.split('/');
    if (url.host !== 'plugins' || !encodedId || segments.length === 0) return notFound;
    try {
        const configured = pluginRoots.get(decodeURIComponent(encodedId));
        if (!configured) return notFound;
        const root = await realpath(configured);
        // Resolving symlinks keeps a link inside the directory from reaching outside it.
        const file = await realpath(join(root, ...segments.map(decodeURIComponent)));
        const type = pluginFileTypes[extname(file).toLowerCase()];
        if (!file.startsWith(root + sep) || !type) return notFound;
        return new Response(new Uint8Array(await readFile(file)), {
            headers: {
                'content-type': type,
                'access-control-allow-origin': '*',
                'x-content-type-options': 'nosniff',
            },
        });
    } catch {
        return notFound;
    }
}

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

/**
 * Show the window, creating it if needed, optionally at a chat.
 * @param sessionId The chat to open.
 */
function showWindow(sessionId?: string): void {
    if (!window) {
        pendingSession = sessionId;
        createWindow();
        return;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    if (sessionId) window.webContents.send('whim:open-session', sessionId);
}

/** Rebuild the menu bar item from the latest activity. */
function updateTray(): void {
    if (!tray) return;
    const { locale, running } = activity;
    const sessions: MenuItemConstructorOptions[] = running.map(session => {
        const title = session.title || mainText(locale, 'untitled');
        return {
            label: session.waiting ? mainText(locale, 'needsYou', { title }) : title,
            click: () => showWindow(session.sessionId),
        };
    });
    tray.setTitle(running.length > 0 ? String(running.length) : '');
    tray.setToolTip(
        running.length > 0
            ? mainText(locale, 'running', { count: running.length })
            : mainText(locale, 'nothingRunning')
    );
    tray.setContextMenu(
        Menu.buildFromTemplate([
            {
                label:
                    running.length > 0
                        ? mainText(locale, 'running', { count: running.length })
                        : mainText(locale, 'nothingRunning'),
                enabled: false,
            },
            ...sessions,
            { type: 'separator' },
            { label: mainText(locale, 'open'), click: () => showWindow() },
            { type: 'separator' },
            { label: mainText(locale, 'quit'), click: () => app.quit() },
        ])
    );
}

/**
 * Take a new activity snapshot: refresh the menu bar item and hold off App Nap while chats run.
 * @param next The snapshot.
 */
function applyActivity(next: Activity): void {
    activity = next;
    if (next.running.length > 0 && powerBlocker === undefined)
        powerBlocker = powerSaveBlocker.start('prevent-app-suspension');
    else if (next.running.length === 0 && powerBlocker !== undefined) {
        powerSaveBlocker.stop(powerBlocker);
        powerBlocker = undefined;
    }
    updateTray();
}

/**
 * Notify about a chat that needs the user, unless a Whim window has focus.
 * @param attention The committed fact.
 */
function notifyAttention(attention: Attention): void {
    if (BrowserWindow.getFocusedWindow() || !Notification.isSupported()) return;
    const { locale } = activity;
    const notification = new Notification({
        title: attention.title || mainText(locale, 'untitled'),
        body: mainText(locale, attention.kind),
    });
    notifications.add(notification);
    notification.on('click', () => showWindow(attention.sessionId));
    notification.on('close', () => notifications.delete(notification));
    notification.show();
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
        else if (message.type === 'plugin-clients') {
            const parsed = pluginClientsSchema.safeParse(message);
            if (parsed.success)
                pluginRoots = new Map(
                    parsed.data.clients.map(client => [client.pluginId, client.root])
                );
        } else if (message.type === 'activity') {
            const parsed = activitySchema.safeParse(message);
            if (parsed.success) applyActivity(parsed.data);
        } else if (message.type === 'attention') {
            const parsed = attentionSchema.safeParse(message);
            if (parsed.success) notifyAttention(parsed.data);
        } else if (message.type === 'ready') {
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
        // Nothing runs while Backend is down; the restarted Backend reports afresh.
        applyActivity({ ...activity, running: [] });
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
    window.webContents.on('did-finish-load', () => {
        connectRenderer();
        if (pendingSession) window?.webContents.send('whim:open-session', pendingSession);
        pendingSession = undefined;
    });
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

/** Ask before a quit interrupts running chats; quit again once confirmed. */
async function confirmQuit(): Promise<void> {
    if (confirmingQuit) return;
    confirmingQuit = true;
    const { locale, running } = activity;
    const options = {
        type: 'warning' as const,
        message: mainText(locale, 'quitTitle'),
        detail: mainText(locale, 'quitDetail', { count: running.length }),
        buttons: [mainText(locale, 'quitConfirm'), mainText(locale, 'cancel')],
        defaultId: 0,
        cancelId: 1,
    };
    try {
        const { response } = window
            ? await dialog.showMessageBox(window, options)
            : await dialog.showMessageBox(options);
        if (response !== 0) return;
        quitConfirmed = true;
        app.quit();
    } finally {
        confirmingQuit = false;
    }
}

// Automated tests on hosts without a keychain opt into Electron's plaintext fallback explicitly.
if (process.env.WHIM_TEST_PLAINTEXT_SECRETS === '1') {
    void app.whenReady().then(() => safeStorage.setUsePlainTextEncryption(true));
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => showWindow());
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
        protocol.handle('whim-plugin', servePluginFile);
        startBackend();
        tray = new Tray(join(here, 'resources', 'trayTemplate.png'));
        updateTray();
        createWindow();
        app.on('activate', () => showWindow());
        // Logout and system shutdown must not wait on a dialog.
        powerMonitor.on('shutdown', () => {
            quitConfirmed = true;
        });
    });
    app.on('window-all-closed', () => {
        // Closing windows never quits: Whim keeps running in the menu bar (design.md §4.1).
    });
    app.on('before-quit', event => {
        if (quitting || !backend) return;
        event.preventDefault();
        if (!quitConfirmed && activity.running.length > 0) {
            void confirmQuit();
            return;
        }
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
