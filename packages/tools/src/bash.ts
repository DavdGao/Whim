import { spawn } from 'node:child_process';
import { basename } from 'node:path';

import { defineTool } from '@whimkit/core/plugin';

import type { ToolContext } from '@whimkit/core/plugin';

export interface BashInput {
    readonly command: string;
    readonly description?: string;
    readonly timeout?: number;
    readonly run_in_background?: boolean;
}

const defaultTimeoutMs = 120_000;
const maxTimeoutMs = 600_000;
/** A foreground call moves to the background after this long. */
const backgroundAfterMs = 30_000;
const killGraceMs = 2000;
/** The in-memory copy keeps this many trailing characters. */
const maxBufferedChars = 1024 * 1024;
/** After the shell exits, wait this long for the output pipes to drain. */
const drainGraceMs = 100;

/**
 * Pick the shell: the user's bash or zsh, otherwise `/bin/bash`.
 * @returns Absolute shell path.
 */
function selectShell(): string {
    const configured = process.env.SHELL;
    if (configured !== undefined && ['bash', 'zsh'].includes(basename(configured))) {
        return configured;
    }
    return '/bin/bash';
}

/**
 * Signal a whole process group; a group that is already gone is not an error.
 * @param pid Group leader pid.
 * @param signal Signal to send.
 */
function killGroup(pid: number, signal: NodeJS.Signals): void {
    try {
        process.kill(-pid, signal);
    } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
            throw error;
        }
    }
}

/**
 * Run a shell command, streaming output through the context.
 * @param input Command and options.
 * @param workspace Working directory.
 * @param context Tool context; its signal terminates the process group.
 * @returns Output plus exit status.
 */
async function runCommand(
    input: BashInput,
    workspace: string,
    context: ToolContext
): Promise<{ content: string; isError: boolean }> {
    const background = input.run_in_background === true;
    const timeoutMs = background ? undefined : (input.timeout ?? defaultTimeoutMs);
    const child = spawn(selectShell(), ['-lc', input.command], {
        cwd: workspace,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pid = child.pid;

    let buffered = '';
    let dropped = 0;
    const onData = (chunk: string): void => {
        context.output(chunk);
        buffered += chunk;
        if (buffered.length > maxBufferedChars) {
            dropped += buffered.length - maxBufferedChars;
            buffered = buffered.slice(-maxBufferedChars);
        }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    let aborted = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const terminate = (): void => {
        if (pid === undefined) {
            return;
        }
        killGroup(pid, 'SIGTERM');
        // Escalate even if the leader exits first: group members may still be alive.
        killTimer ??= setTimeout(() => killGroup(pid, 'SIGKILL'), killGraceMs);
        killTimer.unref();
    };
    const onAbort = (): void => {
        aborted = true;
        terminate();
    };
    context.signal.addEventListener('abort', onAbort, { once: true });
    const timeoutTimer =
        timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                  timedOut = true;
                  terminate();
              }, timeoutMs);

    let drainTimer: NodeJS.Timeout | undefined;
    let status: { code: number | null; signal: NodeJS.Signals | null };
    try {
        status = await new Promise((resolveStatus, rejectStatus) => {
            child.once('error', rejectStatus);
            // `exit` fires when the shell ends even if a background child still holds the pipes.
            child.once('exit', (code, signal) => {
                drainTimer = setTimeout(() => resolveStatus({ code, signal }), drainGraceMs);
                child.once('close', () => resolveStatus({ code, signal }));
            });
            if (context.signal.aborted) {
                onAbort();
            }
        });
    } finally {
        clearTimeout(timeoutTimer);
        clearTimeout(drainTimer);
        context.signal.removeEventListener('abort', onAbort);
        child.stdout.destroy();
        child.stderr.destroy();
    }

    const parts: string[] = [];
    if (dropped > 0) {
        parts.push(`[${dropped} earlier characters of output were dropped]`);
    }
    // Drop the final newline so the status line follows directly.
    parts.push(buffered.endsWith('\n') ? buffered.slice(0, -1) : buffered);
    let failed = true;
    if (timedOut) {
        parts.push(`Command timed out after ${timeoutMs} ms and was terminated.`);
    } else if (aborted) {
        parts.push('Command was aborted and terminated.');
    } else if (status.signal !== null) {
        parts.push(`Terminated by signal ${status.signal}.`);
    } else {
        parts.push(`Exit code ${status.code}`);
        failed = status.code !== 0;
    }
    return { content: parts.filter(part => part !== '').join('\n'), isError: failed };
}

export const bashTool = defineTool<BashInput>({
    name: 'Bash',
    description: [
        'Run a shell command in the workspace using bash and return its combined stdout and stderr plus the exit code.',
        '',
        '- The working directory is the workspace root and does NOT persist between calls; the shell state (cd, exports) is not kept either. Use absolute paths or `cd dir && command` in one call.',
        '- `description` is a short human-readable summary of what the command does.',
        '- `timeout` is in milliseconds (default 120000, max 600000); a timed-out command is terminated.',
        '- A command still running after 30 seconds continues in the background and you get a job handle; its output can be read later and its completion is reported to you. Set `run_in_background` to true for long-running commands such as servers or watchers; those have no timeout.',
        '- Quote paths containing spaces. Chain dependent commands with `&&`.',
        '- Prefer the dedicated tools: Read instead of cat/head/tail, Edit instead of sed, Write instead of echo redirection, Glob instead of find/ls, Grep instead of grep/rg.',
        '- A non-zero exit code is reported as an error.',
    ].join('\n'),
    inputSchema: {
        type: 'object',
        properties: {
            command: { type: 'string', minLength: 1, description: 'Command to execute.' },
            description: { type: 'string', description: 'Short summary of what the command does.' },
            timeout: {
                type: 'integer',
                minimum: 1,
                maximum: maxTimeoutMs,
                description: 'Timeout in milliseconds; default 120000.',
            },
            run_in_background: {
                type: 'boolean',
                description: 'Run in the background without a timeout.',
            },
        },
        required: ['command'],
        additionalProperties: false,
    },
    readOnly: false,
    concurrencySafe: false,
    needsWorkspace: true,
    access: input => [{ kind: 'execute', command: input.command }],
    backgroundAfterMs: input => (input.run_in_background === true ? 0 : backgroundAfterMs),
    async execute(input, context) {
        if (context.workspace === undefined) {
            throw new Error('Bash requires a session workspace.');
        }
        context.signal.throwIfAborted();
        return runCommand(input, context.workspace, context);
    },
});
