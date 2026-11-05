import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

import { bashTool } from './bash.js';
import { createContext, createWorkspace } from './testing.js';

const run = promisify(execFile);

/**
 * Whether a process is still running (zombies count as dead).
 * @param pid Process id.
 * @returns True while the process is alive.
 */
async function isAlive(pid: number): Promise<boolean> {
    try {
        const { stdout } = await run('ps', ['-o', 'stat=', '-p', String(pid)]);
        const state = stdout.trim();
        return state !== '' && !state.startsWith('Z');
    } catch {
        // `ps` exits non-zero when the pid does not exist.
        return false;
    }
}

describe('Bash', () => {
    it('declares execute access, background policy, and flags', () => {
        assert.deepEqual(bashTool.access({ command: 'ls -l' }, { workspace: '/w' }), [
            { kind: 'execute', command: 'ls -l' },
        ]);
        assert.equal(bashTool.backgroundAfterMs?.({ command: 'x' }), 30_000);
        assert.equal(bashTool.backgroundAfterMs?.({ command: 'x', run_in_background: true }), 0);
        assert.equal(bashTool.readOnly, false);
        assert.equal(bashTool.concurrencySafe, false);
    });

    it('runs in the workspace and reports success', async () => {
        const ws = await createWorkspace();
        try {
            const { context } = createContext(ws.dir);
            assert.deepEqual(
                await bashTool.execute({ command: 'pwd; echo out; echo err >&2' }, context),
                {
                    content: `${ws.dir}\nout\nerr\nExit code 0`,
                    isError: false,
                }
            );
        } finally {
            await ws.cleanup();
        }
    });

    it('reports a non-zero exit as an error', async () => {
        const ws = await createWorkspace();
        try {
            const { context } = createContext(ws.dir);
            assert.deepEqual(await bashTool.execute({ command: 'echo bad; exit 3' }, context), {
                content: 'bad\nExit code 3',
                isError: true,
            });
        } finally {
            await ws.cleanup();
        }
    });

    it('streams output chunks as they arrive', async () => {
        const ws = await createWorkspace();
        try {
            const { context, chunks } = createContext(ws.dir);
            const pending = bashTool.execute(
                { command: 'echo first; sleep 0.4; echo second' },
                context
            );
            await sleep(200);
            assert.deepEqual(chunks, ['first\n']);
            const result = await pending;
            assert.deepEqual(chunks, ['first\n', 'second\n']);
            assert.equal(result.isError, false);
        } finally {
            await ws.cleanup();
        }
    });

    it('returns promptly when the shell exits but a background child keeps the pipes open', async () => {
        const ws = await createWorkspace();
        try {
            const { context } = createContext(ws.dir);
            const started = Date.now();
            const result = await bashTool.execute(
                { command: 'sleep 5 >/dev/null 2>&1 & echo done' },
                context
            );
            assert.ok(Date.now() - started < 3000);
            assert.deepEqual(result, { content: 'done\nExit code 0', isError: false });
        } finally {
            await ws.cleanup();
        }
    });

    it('terminates the whole process group on abort', async () => {
        const ws = await createWorkspace();
        try {
            const controller = new AbortController();
            const { context, chunks } = createContext(ws.dir, controller.signal);
            // The foreground sleep replaces the shell, so $$ is its pid; $! is the background one.
            const pending = bashTool.execute(
                { command: 'sleep 30 & echo "$$ $!"; exec sleep 30' },
                context
            );
            while (chunks.length === 0) {
                await sleep(20);
            }
            const [foreground, background] = (chunks[0] ?? '').trim().split(' ').map(Number);
            assert.ok(foreground !== undefined && background !== undefined);
            assert.equal(await isAlive(foreground), true);
            assert.equal(await isAlive(background), true);

            controller.abort();
            const result = await pending;
            assert.deepEqual(result, {
                content: `${foreground} ${background}\nCommand was aborted and terminated.`,
                isError: true,
            });
            await sleep(200);
            assert.equal(await isAlive(foreground), false);
            assert.equal(await isAlive(background), false);
        } finally {
            await ws.cleanup();
        }
    });

    it('kills a process that ignores SIGTERM after the grace period', async () => {
        const ws = await createWorkspace();
        try {
            const controller = new AbortController();
            const { context, chunks } = createContext(ws.dir, controller.signal);
            const pending = bashTool.execute(
                { command: 'trap "" TERM; echo "$$"; while true; do sleep 0.1; done' },
                context
            );
            while (chunks.length === 0) {
                await sleep(20);
            }
            const pid = Number((chunks[0] ?? '').trim());
            controller.abort();
            const started = Date.now();
            const result = await pending;
            assert.equal(result.isError, true);
            assert.ok(Date.now() - started >= 1500);
            await sleep(100);
            assert.equal(await isAlive(pid), false);
        } finally {
            await ws.cleanup();
        }
    });

    it('terminates a command that exceeds the timeout', async () => {
        const ws = await createWorkspace();
        try {
            const { context } = createContext(ws.dir);
            const result = await bashTool.execute(
                { command: 'echo start; sleep 30', timeout: 300 },
                context
            );
            assert.deepEqual(result, {
                content: 'start\nCommand timed out after 300 ms and was terminated.',
                isError: true,
            });
        } finally {
            await ws.cleanup();
        }
    });

    it('applies no timeout to background runs', async () => {
        const ws = await createWorkspace();
        try {
            const { context } = createContext(ws.dir);
            const result = await bashTool.execute(
                { command: 'sleep 0.3; echo ok', timeout: 100, run_in_background: true },
                context
            );
            assert.deepEqual(result, { content: 'ok\nExit code 0', isError: false });
        } finally {
            await ws.cleanup();
        }
    });

    it('keeps only the tail of very large output and says what was dropped', async () => {
        const ws = await createWorkspace();
        try {
            const { context, chunks } = createContext(ws.dir);
            const result = await bashTool.execute(
                { command: 'head -c 1500000 /dev/zero | tr "\\0" x; echo END' },
                context
            );
            assert.equal(chunks.join('').length, 1_500_004);
            assert.match(
                result.content,
                /^\[\d+ earlier characters of output were dropped\]\nx+END\nExit code 0$/
            );
        } finally {
            await ws.cleanup();
        }
    });

    it('fails without a workspace', async () => {
        const { context } = createContext(undefined);
        await assert.rejects(
            bashTool.execute({ command: 'true' }, context),
            /requires a session workspace/
        );
    });
});
