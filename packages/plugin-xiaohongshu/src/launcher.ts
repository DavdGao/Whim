import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { connector, installExecutable } from './install.js';

import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { ChildProcess } from 'node:child_process';

/** Own one connector process and forward MCP messages without exposing local connection details. */
async function main(): Promise<void> {
    const stdio = new StdioServerTransport();
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(580000)]);
    const queued: JSONRPCMessage[] = [];
    let child: ChildProcess | undefined;
    let http: StreamableHTTPClientTransport | undefined;
    let stopping: Promise<void> | undefined;
    let initializeId: string | number | undefined;
    const stop = (): Promise<void> => {
        if (stopping) return stopping;
        stopping = (async () => {
            abort.abort();
            if (child?.pid) {
                const pid = child.pid;
                try {
                    process.kill(-pid, 'SIGTERM');
                } catch (error) {
                    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
                        throw error;
                }
                await delay(500);
                try {
                    process.kill(-pid, 'SIGKILL');
                } catch (error) {
                    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
                        throw error;
                }
            }
            await http?.close();
            await stdio.close();
        })();
        return stopping;
    };
    const fail = async (error: unknown): Promise<void> => {
        const message = error instanceof Error ? error.message : 'Connection preparation failed.';
        process.exitCode = 1;
        try {
            for (const request of queued.splice(0))
                if ('id' in request)
                    await stdio.send({
                        jsonrpc: '2.0',
                        id: request.id,
                        error: { code: -32603, message },
                    });
        } finally {
            await stop();
        }
    };
    const close = () => {
        void stop().then(
            () => process.exit(0),
            () => process.exit(1)
        );
    };
    process.once('SIGTERM', close);
    process.once('SIGINT', close);
    process.stdin.once('end', close);
    stdio.onmessage = message => {
        if ('method' in message && message.method === 'initialize' && 'id' in message)
            initializeId = message.id;
        if (!http) {
            if (queued.length < 32) queued.push(message);
            else
                void fail(new Error('Too many requests while preparing the connector.')).catch(
                    close
                );
            return;
        }
        void http.send(message).catch(error => fail(error).catch(close));
    };
    stdio.onerror = error => {
        void fail(error).catch(close);
    };
    await stdio.start();
    try {
        const directory = process.argv[2];
        if (!directory || !isAbsolute(directory))
            throw new Error('A private data directory is required.');
        if (process.platform !== 'darwin' || process.arch !== 'arm64')
            throw new Error('The managed Xiaohongshu connector requires an Apple silicon Mac.');
        const executable = await installExecutable(directory, connector, signal);
        signal.throwIfAborted();
        const reservation = createServer();
        await new Promise<void>((resolve, reject) => {
            reservation.once('error', reject);
            reservation.listen(0, '127.0.0.1', resolve);
        });
        const address = reservation.address();
        if (!address || typeof address === 'string')
            throw new Error('Could not choose a local port.');
        const port = address.port;
        await new Promise<void>((resolve, reject) =>
            reservation.close(error => (error ? reject(error) : resolve()))
        );
        signal.throwIfAborted();
        const token = randomBytes(32).toString('hex');
        child = spawn(executable, ['-port', `127.0.0.1:${port}`], {
            cwd: directory,
            detached: true,
            stdio: ['ignore', 'ignore', 'pipe'],
            env: {
                PATH: process.env.PATH ?? '/usr/bin:/bin',
                ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
                AUTH_TOKEN: token,
                COOKIES_PATH: join(directory, 'cookies.json'),
            },
        });
        let downloadFailure: string | undefined;
        child.stderr?.on('data', (data: Buffer) => {
            // Keep only the known download status, never arbitrary connector logs or account data.
            const status = /HTTP (\d{3}): https:\/\/cdn\.one-world\.ai\/browsers\//.exec(
                data.toString()
            );
            if (status)
                downloadFailure = `Browser download failed (HTTP ${status[1]} from cdn.one-world.ai).`;
        });
        let childFailure: Error | undefined;
        child.once('error', error => {
            childFailure = error;
        });
        child.once('exit', (code, termination) => {
            childFailure = new Error(
                `${downloadFailure ?? `Xiaohongshu service exited (${termination ?? code}).`} Check network access and retry setup.`
            );
            if (http && !abort.signal.aborted) void fail(childFailure).catch(close);
        });
        const url = `http://127.0.0.1:${port}`;
        for (;;) {
            signal.throwIfAborted();
            if (childFailure) throw childFailure;
            try {
                const response = await fetch(`${url}/health`, {
                    signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
                });
                await response.body?.cancel();
                if (response.ok) break;
            } catch (error) {
                if (signal.aborted) throw error;
                // The owned service may still be downloading its browser or binding its port.
            }
            await delay(300, undefined, { signal });
        }
        http = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
            requestInit: { headers: { Authorization: `Bearer ${token}` } },
        });
        http.onmessage = message => {
            if (
                'result' in message &&
                message.id === initializeId &&
                typeof message.result.protocolVersion === 'string'
            )
                http?.setProtocolVersion(message.result.protocolVersion);
            void stdio.send(message).catch(error => fail(error).catch(close));
        };
        http.onerror = error => {
            void fail(error).catch(close);
        };
        await http.start();
        for (const message of queued.splice(0)) await http.send(message);
    } catch (error) {
        if (!abort.signal.aborted) await fail(error);
    }
}

void main().catch(() => {
    process.exitCode = 1;
});
