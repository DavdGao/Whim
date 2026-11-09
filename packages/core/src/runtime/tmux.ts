import { spawn } from 'node:child_process';
import { lstat, mkdir, stat } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';

// tmux sessions on this Mac or an SSH host, run through the system shell and OpenSSH
// (design.md §11.4). tmux owns the execution; Whim lists, starts, attaches, and ends sessions.

/** Where coding sessions run. */
export type TerminalHost =
    | { readonly kind: 'local' }
    | {
          readonly kind: 'ssh';
          /** An OpenSSH destination: `user@host`, `host`, or a `~/.ssh/config` alias. */
          readonly destination: string;
      };

/** An OpenSSH destination Whim accepts: no options, spaces, or shell syntax. */
export const sshDestinationPattern = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+$/;

/** One tmux session as the host's default server reports it. */
export interface TmuxSession {
    /** `<serverPid>:<sessionId>:<created>`: tmux reuses session ids after a server restart. */
    readonly key: string;
    /** tmux's session id, such as `$3`. */
    readonly id: string;
    readonly name: string;
    readonly createdAt: string;
    /** Clients attached to it, Whim's own included. */
    readonly attachedClients: number;
    /** The active pane's working folder on the host. */
    readonly folder: string;
    /** The active pane's foreground command, such as `zsh` or `claude`. */
    readonly command: string;
    /** The coding agent Whim started it with; absent for sessions started elsewhere. */
    readonly agentId?: string;
}

/** The inventory of one host; unavailable hosts are states, not exceptions. */
export type TmuxInventory =
    | { readonly status: 'ok'; readonly sessions: readonly TmuxSession[] }
    | { readonly status: 'tmux-missing' }
    | { readonly status: 'unreachable'; readonly detail: string };

/** Why a tmux operation failed. */
export class TerminalError extends Error {
    readonly code: 'tmux-missing' | 'unreachable' | 'not-found' | 'invalid' | 'failed';

    /**
     * Create the error.
     * @param code The failure kind.
     * @param message A one-line description including the tool's own output.
     */
    constructor(code: TerminalError['code'], message: string) {
        super(message);
        this.name = 'TerminalError';
        this.code = code;
    }
}

/** A program and its arguments, for a PTY or a child process. */
export interface Invocation {
    readonly file: string;
    readonly args: readonly string[];
}

/**
 * Quote one word for a POSIX shell.
 * @param word The word.
 * @returns It, single-quoted where needed.
 */
export function shellQuote(word: string): string {
    return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * The user's login shell: bash or zsh, else bash, as the Bash tool chooses.
 * @returns Its path.
 */
function loginShell(): string {
    const configured = process.env.SHELL ?? userInfo().shell ?? '';
    return ['bash', 'zsh'].includes(basename(configured)) ? configured : '/bin/bash';
}

const formatFields = [
    '#{pid}',
    '#{session_id}',
    '#{session_created}',
    '#{session_attached}',
    '#{@whim-agent}',
    '#{pane_current_path}',
    '#{pane_current_command}',
    // Last: a session name may contain anything but a newline.
    '#{session_name}',
];

/**
 * Parse `list-sessions` output in `formatFields` order.
 * @param stdout The output.
 * @returns Sessions, oldest first.
 */
export function parseSessions(stdout: string): TmuxSession[] {
    const sessions: TmuxSession[] = [];
    for (const line of stdout.split('\n')) {
        const fields = line.split('\t');
        if (fields.length < formatFields.length) continue;
        const [pid, id, created, attached, agentId, folder, command] = fields;
        const name = fields.slice(formatFields.length - 1).join('\t');
        if (!pid || !id || !created) continue;
        sessions.push({
            key: `${pid}:${id}:${created}`,
            id,
            name,
            createdAt: new Date(Number(created) * 1000).toISOString(),
            attachedClients: Number(attached) || 0,
            folder: folder ?? '',
            command: command ?? '',
            ...(agentId ? { agentId } : {}),
        });
    }
    return sessions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * The environment of tmux and SSH processes. `TMUX` is removed: inherited from a terminal that
 * started Whim, it would point tmux at that server and refuse attaching as nesting.
 * @returns The environment.
 */
export function childEnv(): NodeJS.ProcessEnv {
    const { TMUX: _tmux, TMUX_PANE: _pane, ...env } = process.env;
    return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
}

/** The longest socket path macOS' `sun_path` holds (104 bytes with the terminator). */
const maxSocketPath = 103;
/** `%C` expands to a 40-character hash; a master first binds `<path>.<16 random chars>`. */
const controlPathGrowth = 40 - 2 + 17;

/**
 * The OpenSSH options every command to a host uses: keep-alives and, when the socket path fits,
 * one shared master connection.
 * @param controlDir Directory for control sockets; see `prepareControlDir`.
 * @returns The options.
 */
export function sshOptions(controlDir: string): string[] {
    const socket = join(controlDir, '%C');
    const options = ['-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];
    // OpenSSH splits an option's value on spaces unless it is quoted.
    if (socket.length + controlPathGrowth > maxSocketPath || socket.includes('"')) return options;
    return [
        ...options,
        '-o',
        'ControlMaster=auto',
        '-o',
        `ControlPath="${socket}"`,
        '-o',
        'ControlPersist=60',
    ];
}

/**
 * Create the control socket directory, or check an existing one: OpenSSH needs it private, and a
 * directory under a shared parent such as `/tmp` could have been created by another user.
 * @param path The directory.
 */
export async function prepareControlDir(path: string): Promise<void> {
    try {
        await mkdir(path, { mode: 0o700 });
    } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    const info = await lstat(path);
    if (!info.isDirectory() || info.uid !== userInfo().uid || (info.mode & 0o077) !== 0)
        throw new TerminalError(
            'failed',
            `${path} must be a directory only you can access; remove it and try again.`
        );
}

/** Commands for one host's default tmux server. */
export class Tmux {
    readonly host: TerminalHost;
    readonly #sshOptions: readonly string[];

    /**
     * Commands for one host; an SSH destination that could be an option or shell syntax throws.
     * @param host Where tmux runs.
     * @param controlDir Directory for OpenSSH control sockets, shared by every SSH host.
     */
    constructor(host: TerminalHost, controlDir: string) {
        this.host = host;
        if (host.kind === 'ssh' && !sshDestinationPattern.test(host.destination))
            throw new TerminalError('invalid', `Invalid SSH destination ${host.destination}.`);
        this.#sshOptions = sshOptions(controlDir);
    }

    /**
     * How to run a shell command line on the host.
     * @param line A POSIX shell command line, already quoted.
     * @param interactive Whether it needs a terminal (`ssh -t`).
     * @returns The invocation.
     */
    #invocation(line: string, interactive: boolean): Invocation {
        if (this.host.kind === 'local') return { file: loginShell(), args: ['-lc', line] };
        return {
            file: 'ssh',
            args: [
                ...this.#sshOptions,
                ...(interactive ? ['-t'] : ['-o', 'BatchMode=yes', '-T']),
                '--',
                this.host.destination,
                line,
            ],
        };
    }

    /**
     * Run a command line on the host and collect its output.
     * @param line The command line.
     * @param signal Cancels the command.
     * @returns Exit code and output.
     */
    async #run(
        line: string,
        signal: AbortSignal
    ): Promise<{ code: number; stdout: string; stderr: string }> {
        const { file, args } = this.#invocation(line, false);
        return await new Promise((resolve, reject) => {
            const child = spawn(file, args, {
                cwd: homedir(),
                env: childEnv(),
                stdio: ['ignore', 'pipe', 'pipe'],
                signal,
            });
            let stdout = '';
            let stderr = '';
            child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
            child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
            child.once('error', reject);
            child.once('close', code => resolve({ code: code ?? -1, stdout, stderr }));
        });
    }

    /**
     * Run tmux, turning shell and SSH failures into `TerminalError`.
     * @param args tmux arguments.
     * @param signal Cancels the command.
     * @returns Its standard output.
     */
    async #tmux(args: readonly string[], signal: AbortSignal): Promise<string> {
        const result = await this.#run(['exec', 'tmux', ...args].map(shellQuote).join(' '), signal);
        if (result.code === 0) return result.stdout;
        throw this.#failure(result.code, result.stderr);
    }

    /**
     * Classify a failed command.
     * @param code Its exit code.
     * @param stderr Its error output.
     * @returns The error.
     */
    #failure(code: number, stderr: string): TerminalError {
        const detail = stderr.trim().split('\n').slice(-3).join(' ') || `exit code ${code}`;
        if (code === 127)
            return new TerminalError('tmux-missing', `tmux is not installed: ${detail}`);
        if (this.host.kind === 'ssh' && code === 255)
            return new TerminalError('unreachable', detail);
        return new TerminalError('failed', detail);
    }

    /**
     * List the sessions of the host's default tmux server.
     * @param signal Cancels the query.
     * @returns The inventory; no running server means no sessions.
     */
    async list(signal: AbortSignal): Promise<TmuxInventory> {
        try {
            const stdout = await this.#tmux(
                ['list-sessions', '-F', formatFields.join('\t')],
                signal
            );
            return { status: 'ok', sessions: parseSessions(stdout) };
        } catch (error) {
            if (!(error instanceof TerminalError)) throw error;
            if (error.code === 'tmux-missing') return { status: 'tmux-missing' };
            if (error.code === 'unreachable')
                return { status: 'unreachable', detail: error.message };
            // tmux reports a missing server instead of an empty list.
            if (/no server running|error connecting to/.test(error.message))
                return { status: 'ok', sessions: [] };
            throw error;
        }
    }

    /**
     * Resolve a folder on the host to an absolute path, failing when it does not exist.
     * tmux would otherwise silently start in the home folder.
     * @param folder An absolute path, `~`, or `~/…`; empty means the home folder.
     * @param signal Cancels the check.
     * @returns The absolute path.
     */
    async resolveFolder(folder: string, signal: AbortSignal): Promise<string> {
        const trimmed = folder.trim();
        if (this.host.kind === 'local') {
            const path =
                trimmed === '' || trimmed === '~'
                    ? homedir()
                    : trimmed.startsWith('~/')
                      ? join(homedir(), trimmed.slice(2))
                      : trimmed;
            if (!isAbsolute(path)) throw new TerminalError('invalid', `${folder} is not absolute.`);
            const info = await stat(path).catch(() => undefined);
            if (!info?.isDirectory())
                throw new TerminalError('not-found', `${path} is not a folder.`);
            return path;
        }
        const expression =
            trimmed === '' || trimmed === '~'
                ? '"$HOME"'
                : trimmed.startsWith('~/')
                  ? `"$HOME"/${shellQuote(trimmed.slice(2))}`
                  : shellQuote(trimmed);
        if (!expression.startsWith('"$HOME"') && !trimmed.startsWith('/'))
            throw new TerminalError('invalid', `${folder} is not absolute.`);
        const result = await this.#run(`cd -- ${expression} && pwd -P`, signal);
        if (result.code !== 0) {
            const failure = this.#failure(result.code, result.stderr);
            throw failure.code === 'failed'
                ? new TerminalError('not-found', `${folder} is not a folder: ${failure.message}`)
                : failure;
        }
        return result.stdout.trim();
    }

    /**
     * Start a detached session and type a command into its shell, so the command gets the user's
     * interactive environment and the shell stays when it exits.
     * @param options The session.
     * @param options.name Session name; tmux names are unique per server.
     * @param options.folder Absolute folder on the host.
     * @param options.agentId Recorded as the `@whim-agent` session option.
     * @param options.command The argv to type.
     * @param signal Cancels the start.
     * @returns The new session.
     */
    async create(
        options: { name: string; folder: string; agentId: string; command: readonly string[] },
        signal: AbortSignal
    ): Promise<TmuxSession> {
        // Later commands of one sequence act on the session it created; tmux resolves `-t`
        // targets before the sequence runs, so they cannot name it.
        await this.#tmux(
            [
                'new-session',
                '-d',
                '-s',
                options.name,
                '-c',
                options.folder,
                '-x',
                '160',
                '-y',
                '48',
                ';',
                'set-option',
                '@whim-agent',
                options.agentId,
                ';',
                'send-keys',
                '-l',
                options.command.map(shellQuote).join(' '),
                ';',
                'send-keys',
                'Enter',
            ],
            signal
        );
        const inventory = await this.list(signal);
        const session =
            inventory.status === 'ok'
                ? inventory.sessions.find(item => item.name === options.name)
                : undefined;
        if (!session) throw new TerminalError('failed', `Session ${options.name} did not start.`);
        return session;
    }

    /**
     * End a session after checking it is still the one the user chose.
     * @param key The session's `key`.
     * @param signal Cancels the operation.
     */
    async kill(key: string, signal: AbortSignal): Promise<void> {
        const session = await this.#find(key, signal);
        await this.#tmux(['kill-session', '-t', session.id], signal);
    }

    /**
     * Find a live session by key.
     * @param key The session's `key`.
     * @param signal Cancels the query.
     * @returns The session.
     */
    async #find(key: string, signal: AbortSignal): Promise<TmuxSession> {
        const inventory = await this.list(signal);
        if (inventory.status === 'tmux-missing')
            throw new TerminalError('tmux-missing', 'tmux is not installed.');
        if (inventory.status === 'unreachable')
            throw new TerminalError('unreachable', inventory.detail);
        const session = inventory.sessions.find(item => item.key === key);
        if (!session) throw new TerminalError('not-found', 'The session has ended.');
        return session;
    }

    /**
     * How to attach a terminal to a live session. Attaching only adds a tmux client: it never
     * starts the CLI again or sends it input.
     * @param key The session's `key`.
     * @param signal Cancels the lookup.
     * @returns The invocation for a PTY.
     */
    async attachInvocation(key: string, signal: AbortSignal): Promise<Invocation> {
        const session = await this.#find(key, signal);
        // `-u`: GUI apps on macOS often lack a UTF-8 locale, which makes tmux draw `_` for text.
        return this.#invocation(
            ['exec', 'tmux', '-u', 'attach-session', '-t', session.id].map(shellQuote).join(' '),
            true
        );
    }
}
