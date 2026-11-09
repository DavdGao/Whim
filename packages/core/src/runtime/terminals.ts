import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

import { spawn } from 'node-pty';

import { TerminalError, childEnv } from './tmux.js';

import type { Invocation } from './tmux.js';
import type { IPty } from 'node-pty';

// Interactive terminals attached to tmux sessions (design.md §11.4). A terminal belongs to the view
// that opened it; closing it detaches the tmux client and leaves the session running.

/** What a terminal reports to its owner. */
export type TerminalEvent =
    | { readonly type: 'output'; readonly terminalId: string; readonly data: string }
    | {
          readonly type: 'exit';
          readonly terminalId: string;
          readonly exitCode: number;
          readonly signal?: number;
      };

/** Output not yet acknowledged above which the PTY is paused, and below which it resumes. */
export const pauseAboveChars = 1_000_000;
export const resumeBelowChars = 250_000;

interface Terminal {
    readonly pty: IPty;
    readonly owner: AbortSignal;
    unacknowledged: number;
    paused: boolean;
}

/** Owns the PTYs of attached views. */
export class Terminals {
    readonly #terminals = new Map<string, Terminal>();
    readonly #emit: (event: TerminalEvent) => void;

    /**
     * Create an empty set of terminals.
     * @param emit Receives output and exits of every terminal.
     */
    constructor(emit: (event: TerminalEvent) => void) {
        this.#emit = emit;
    }

    /**
     * Start a terminal running an attach invocation.
     * @param invocation The program, such as `tmux attach-session` or `ssh -t`.
     * @param size Columns and rows of the view.
     * @param size.cols Columns.
     * @param size.rows Rows.
     * @param owner Closes the terminal when it aborts, such as when its window is replaced.
     * @returns The terminal's id.
     */
    open(invocation: Invocation, size: { cols: number; rows: number }, owner: AbortSignal): string {
        if (owner.aborted) throw new TerminalError('failed', 'The window closed.');
        const terminalId = randomUUID();
        const pty = spawn(invocation.file, [...invocation.args], {
            name: 'xterm-256color',
            cols: size.cols,
            rows: size.rows,
            cwd: homedir(),
            env: childEnv(),
        });
        const terminal: Terminal = { pty, owner, unacknowledged: 0, paused: false };
        this.#terminals.set(terminalId, terminal);
        const close = () => this.close(terminalId);
        owner.addEventListener('abort', close, { once: true });
        pty.onData(data => {
            terminal.unacknowledged += data.length;
            if (!terminal.paused && terminal.unacknowledged > pauseAboveChars) {
                terminal.paused = true;
                pty.pause();
            }
            this.#emit({ type: 'output', terminalId, data });
        });
        pty.onExit(({ exitCode, signal }) => {
            owner.removeEventListener('abort', close);
            this.#terminals.delete(terminalId);
            this.#emit({
                type: 'exit',
                terminalId,
                exitCode,
                ...(signal ? { signal } : {}),
            });
        });
        return terminalId;
    }

    /**
     * Look up a live terminal.
     * @param terminalId The terminal.
     * @returns It.
     */
    #get(terminalId: string): Terminal {
        const terminal = this.#terminals.get(terminalId);
        if (!terminal) throw new TerminalError('not-found', 'The terminal has closed.');
        return terminal;
    }

    /**
     * Type into a terminal: keys, pasted text, or IME input exactly as the view produced it.
     * @param terminalId The terminal.
     * @param data The input.
     */
    write(terminalId: string, data: string): void {
        this.#get(terminalId).pty.write(data);
    }

    /**
     * Resize a terminal to its view.
     * @param terminalId The terminal.
     * @param cols Columns.
     * @param rows Rows.
     */
    resize(terminalId: string, cols: number, rows: number): void {
        this.#get(terminalId).pty.resize(cols, rows);
    }

    /**
     * Record that the view has rendered output, resuming a paused terminal.
     * @param terminalId The terminal.
     * @param chars Characters rendered since the last acknowledgment.
     */
    acknowledge(terminalId: string, chars: number): void {
        const terminal = this.#terminals.get(terminalId);
        if (!terminal) return;
        terminal.unacknowledged = Math.max(0, terminal.unacknowledged - chars);
        if (terminal.paused && terminal.unacknowledged < resumeBelowChars) {
            terminal.paused = false;
            terminal.pty.resume();
        }
    }

    /**
     * Close a terminal: its client process ends and the tmux session keeps running.
     * The exit is still reported.
     * @param terminalId The terminal.
     */
    close(terminalId: string): void {
        const terminal = this.#terminals.get(terminalId);
        if (!terminal) return;
        // A paused PTY would not deliver its exit.
        terminal.pty.resume();
        terminal.pty.kill('SIGHUP');
    }

    /** Close every terminal, at shutdown. */
    closeAll(): void {
        for (const terminalId of [...this.#terminals.keys()]) this.close(terminalId);
    }
}
