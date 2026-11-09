import { randomBytes, randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { join } from 'node:path';

import { prepareControlDir, TerminalError, Terminals, Tmux } from '@whimkit/core';
import { z } from 'zod';

import { codingHostSchema, methodSchemas } from '../shared/ipc.js';

import type { CodingHost, CodingInventory, Results } from '../shared/ipc.js';
import type { PluginHost, Store, TerminalEvent } from '@whimkit/core';

// The Coding page's hosts, tmux sessions, and terminals (design.md §11.4).

const hostsSetting = 'coding.hosts';
/** Bounds how long a listing or start may take, SSH connection included. */
const commandTimeoutMs = 20_000;

export type CodingMethod =
    | 'coding.saveHost'
    | 'coding.removeHost'
    | 'coding.sessions'
    | 'coding.create'
    | 'coding.kill'
    | 'terminal.open'
    | 'terminal.input'
    | 'terminal.resize'
    | 'terminal.ack'
    | 'terminal.close';

/** Owns coding hosts in settings, tmux commands, and the terminals of attached views. */
export class Coding {
    readonly #store: Store;
    readonly #plugins: PluginHost;
    readonly #controlDir: string;
    readonly terminals: Terminals;

    /**
     * Create the service; nothing runs until a method is called.
     * @param store Settings storage.
     * @param plugins Provides the coding agents.
     * @param emit Forwards terminal events to the window.
     */
    constructor(store: Store, plugins: PluginHost, emit: (event: TerminalEvent) => void) {
        this.#store = store;
        this.#plugins = plugins;
        // A short path: socket paths are limited to 103 bytes, and the data folder under
        // `~/Library/Application Support` is too long and contains a space.
        this.#controlDir = join('/tmp', `whim-${userInfo().uid}`);
        this.terminals = new Terminals(emit);
    }

    /**
     * The saved SSH hosts.
     * @returns Hosts in the order they were added.
     */
    async hosts(): Promise<CodingHost[]> {
        const parsed = z
            .array(codingHostSchema)
            .safeParse(await this.#store.getSetting(hostsSetting));
        return parsed.success ? parsed.data : [];
    }

    /**
     * The tmux commands of a host.
     * @param hostId `local` or a saved host's id.
     * @returns The commands.
     */
    async #tmux(hostId: string): Promise<Tmux> {
        if (hostId === 'local') return new Tmux({ kind: 'local' }, this.#controlDir);
        const host = (await this.hosts()).find(item => item.id === hostId);
        if (!host) throw new TerminalError('not-found', 'The host was removed.');
        await prepareControlDir(this.#controlDir);
        return new Tmux({ kind: 'ssh', destination: host.destination }, this.#controlDir);
    }

    /**
     * Handle one Coding method.
     * @param method The method.
     * @param raw Its unvalidated parameters.
     * @param owner The window's scope; its terminals close when it is replaced.
     * @returns The result.
     */
    async dispatch(
        method: CodingMethod,
        raw: unknown,
        owner: AbortSignal
    ): Promise<Results[CodingMethod]> {
        switch (method) {
            case 'coding.saveHost': {
                const params = methodSchemas[method].parse(raw);
                const hosts = await this.hosts();
                const id = params.id ?? randomUUID();
                const host = { id, label: params.label, destination: params.destination };
                const index = hosts.findIndex(item => item.id === id);
                if (index >= 0) hosts[index] = host;
                else hosts.push(host);
                await this.#store.setSetting(hostsSetting, hosts);
                return { id };
            }
            case 'coding.removeHost': {
                const { id } = methodSchemas[method].parse(raw);
                await this.#store.setSetting(
                    hostsSetting,
                    (await this.hosts()).filter(item => item.id !== id)
                );
                return null;
            }
            case 'coding.sessions': {
                const { hostId } = methodSchemas[method].parse(raw);
                const tmux = await this.#tmux(hostId);
                const inventory = await tmux.list(AbortSignal.timeout(commandTimeoutMs));
                return inventory satisfies CodingInventory;
            }
            case 'coding.create': {
                const params = methodSchemas[method].parse(raw);
                const agent = this.#plugins.codingAgents.get(params.agentId);
                if (!agent)
                    throw new TerminalError('not-found', 'That coding agent is not available.');
                const tmux = await this.#tmux(params.hostId);
                const signal = AbortSignal.timeout(commandTimeoutMs);
                const folder = await tmux.resolveFolder(params.folder, signal);
                // The plugin's name part, so `tmux ls` elsewhere shows what runs in it.
                const name = `${agent.agent.id.split('#').pop() ?? 'agent'}-${randomBytes(3).toString('hex')}`;
                const session = await tmux.create(
                    { name, folder, agentId: agent.agent.id, command: agent.agent.command },
                    signal
                );
                return { key: session.key };
            }
            case 'coding.kill': {
                const params = methodSchemas[method].parse(raw);
                const tmux = await this.#tmux(params.hostId);
                await tmux.kill(params.key, AbortSignal.timeout(commandTimeoutMs));
                return null;
            }
            case 'terminal.open': {
                const params = methodSchemas[method].parse(raw);
                const tmux = await this.#tmux(params.hostId);
                const invocation = await tmux.attachInvocation(
                    params.key,
                    AbortSignal.timeout(commandTimeoutMs)
                );
                return {
                    terminalId: this.terminals.open(
                        invocation,
                        { cols: params.cols, rows: params.rows },
                        owner
                    ),
                };
            }
            case 'terminal.input': {
                const params = methodSchemas[method].parse(raw);
                this.terminals.write(params.terminalId, params.data);
                return null;
            }
            case 'terminal.resize': {
                const params = methodSchemas[method].parse(raw);
                this.terminals.resize(params.terminalId, params.cols, params.rows);
                return null;
            }
            case 'terminal.ack': {
                const params = methodSchemas[method].parse(raw);
                this.terminals.acknowledge(params.terminalId, params.chars);
                return null;
            }
            case 'terminal.close':
                this.terminals.close(methodSchemas[method].parse(raw).terminalId);
                return null;
        }
    }
}
