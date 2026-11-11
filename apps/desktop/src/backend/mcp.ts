import { McpHost, mcpServerSchema, StoreError } from '@whimkit/core';
import { z } from 'zod';

import { methodSchemas } from '../shared/ipc.js';

import type { McpServerInfo, Results } from '../shared/ipc.js';
import type { McpServerConfig, SecretCipher, Store } from '@whimkit/core';

// MCP server settings and their shared connections (design.md §7.7).

const serversSetting = 'mcp.servers';

export type McpMethod = 'mcp.save' | 'mcp.remove';

/** Owns the MCP server configurations in settings and the host that connects them. */
export class McpServers {
    readonly host: McpHost;

    /**
     * Create the service; nothing connects until `start`.
     * @param store Settings storage.
     * @param cipher Encrypts secret values; decrypts them only to start a server.
     * @param version Whim's version, reported to servers.
     * @param changed Called when a server's state or tools change.
     */
    constructor(
        private readonly store: Store,
        private readonly cipher: SecretCipher,
        version: string,
        changed: () => void
    ) {
        this.host = new McpHost({
            decrypt: ciphertext => this.cipher.decrypt(new Uint8Array(ciphertext)),
            client: { name: 'Whim', version },
            onChange: changed,
        });
    }

    /**
     * The saved servers; an unreadable entry is dropped rather than blocking the rest.
     * @returns Servers in the order they were added.
     */
    async #configs(): Promise<McpServerConfig[]> {
        const saved = z.array(z.unknown()).safeParse(await this.store.getSetting(serversSetting));
        if (!saved.success) return [];
        return saved.data.flatMap(item => {
            const parsed = mcpServerSchema.safeParse(item);
            return parsed.success ? [parsed.data] : [];
        });
    }

    /** Connect the enabled servers. */
    async start(): Promise<void> {
        await this.host.configure(await this.#configs());
    }

    /** Close every connection. */
    async stop(): Promise<void> {
        await this.host.stop();
    }

    /**
     * The servers for Renderer, with their states and without secret values.
     * @returns The servers.
     */
    async views(): Promise<McpServerInfo[]> {
        return (await this.#configs()).map(({ secrets, ...config }) => ({
            ...config,
            secrets: Object.keys(secrets),
            status: this.host.state(config.id),
        }));
    }

    /**
     * Handle one MCP method.
     * @param method The method.
     * @param raw Its unvalidated parameters.
     * @returns The result.
     */
    async dispatch(method: McpMethod, raw: unknown): Promise<Results[McpMethod]> {
        const configs = await this.#configs();
        switch (method) {
            case 'mcp.save': {
                const params = methodSchemas[method].parse(raw);
                const index = configs.findIndex(item => item.id === params.server.id);
                if (index >= 0 && !params.replace)
                    throw new StoreError('conflict', 'Another server already has this id.');
                const secrets = { ...(index >= 0 ? configs[index]?.secrets : {}) };
                for (const name of params.removeSecrets) delete secrets[name];
                for (const [name, value] of Object.entries(params.secretValues))
                    secrets[name] = Buffer.from(await this.cipher.encrypt(value)).toString(
                        'base64'
                    );
                const config = mcpServerSchema.parse({ ...params.server, secrets });
                if (index >= 0) configs[index] = config;
                else configs.push(config);
                break;
            }
            case 'mcp.remove': {
                const { id } = methodSchemas[method].parse(raw);
                const index = configs.findIndex(item => item.id === id);
                if (index >= 0) configs.splice(index, 1);
                break;
            }
        }
        await this.store.setSetting(serversSetting, configs);
        await this.host.configure(configs);
        return null;
    }
}
