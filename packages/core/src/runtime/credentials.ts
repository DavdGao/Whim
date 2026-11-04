import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { idSchema } from '../contracts/card.js';
import { ApplicationError } from '../contracts/failure.js';

import type { SchemaIssue } from './json-schema.js';
import type { PluginHost } from './plugin-host.js';
import type { Store } from './store.js';
import type { ResolvedCredential } from '../plugin/index.js';

/** Encrypts secrets with an OS-protected key. Desktop implements it with Electron safeStorage. */
export interface SecretCipher {
    encrypt(plaintext: string): Promise<Uint8Array<ArrayBuffer>>;
    decrypt(ciphertext: Uint8Array<ArrayBuffer>): Promise<string>;
}

/** What Renderer may see: no secret values, only which secrets are set. */
export interface CredentialView {
    readonly id: string;
    readonly typeId: string;
    readonly label: string;
    readonly values: Readonly<Record<string, unknown>>;
    readonly secretsSet: readonly string[];
    readonly createdAt: string;
    /** False when no active plugin registers this credential's type. */
    readonly available: boolean;
}

export const credentialInputSchema = z.strictObject({
    id: idSchema.optional(),
    typeId: idSchema,
    label: z.string().trim().min(1).max(200),
    /** Plain and secret values; omitted secrets keep their stored value. */
    values: z.record(z.string(), z.unknown()),
});
export type CredentialInput = z.infer<typeof credentialInputSchema>;

/** Raised when credential values do not satisfy the type's schema. */
export class CredentialValidationError extends Error {
    /**
     * Carry schema issues to the caller.
     * @param issues The validation issues.
     */
    constructor(readonly issues: readonly SchemaIssue[]) {
        super(issues.map(issue => `${issue.path}: ${issue.message}`).join('; '));
        this.name = 'CredentialValidationError';
    }
}

/** Creates, updates, lists, and resolves credentials; secrets never leave Backend in clear text. */
export class CredentialService {
    /**
     * Create the service.
     * @param store Persistence.
     * @param host Plugin registrations providing credential types.
     * @param cipher Secret encryption.
     */
    constructor(
        private readonly store: Store,
        private readonly host: PluginHost,
        private readonly cipher: SecretCipher
    ) {}

    /**
     * List credentials for display.
     * @returns Credential views without secrets.
     */
    async list(): Promise<CredentialView[]> {
        return (await this.store.credentials()).map(({ credential, secretProperties }) => ({
            id: credential.id,
            typeId: credential.typeId,
            label: credential.label,
            values: credential.plainValues,
            secretsSet: secretProperties,
            createdAt: credential.createdAt,
            available: this.host.credentialTypes.has(credential.typeId),
        }));
    }

    /**
     * Create or update a credential after validating it against its type.
     * @param input Untrusted input from Renderer.
     * @returns The stored credential id.
     */
    async save(input: CredentialInput): Promise<string> {
        const registered = this.host.credentialTypes.get(input.typeId);
        if (!registered) throw new Error(`Credential type ${input.typeId} is not available.`);
        const existing = input.id
            ? (await this.store.credentials()).find(entry => entry.credential.id === input.id)
            : undefined;
        if (input.id && !existing) throw new Error('Credential not found.');
        if (existing && existing.credential.typeId !== input.typeId)
            throw new Error('A credential cannot change its type.');
        const secretNames = new Set(registered.schema.secretProperties());
        const plain: Record<string, unknown> = {};
        const secrets: Record<string, string> = {};
        const removed: string[] = [];
        for (const [key, value] of Object.entries(input.values)) {
            if (!secretNames.has(key)) {
                if (value !== '' && value !== undefined && value !== null) plain[key] = value;
            } else if (typeof value === 'string' && value.length > 0) secrets[key] = value;
            else if (value === null) removed.push(key);
        }
        // Validate the complete object: kept secrets count as present.
        const candidate: Record<string, unknown> = { ...plain, ...secrets };
        for (const name of existing?.secretProperties ?? [])
            if (!(name in candidate) && !removed.includes(name)) candidate[name] = 'stored';
        const issues = registered.schema.issues(candidate);
        if (issues.length) throw new CredentialValidationError(issues);
        const encrypted: Record<string, Uint8Array<ArrayBuffer>> = {};
        for (const [key, value] of Object.entries(secrets))
            encrypted[key] = await this.cipher.encrypt(value);
        const id = input.id ?? randomUUID();
        await this.store.putCredential(
            {
                id,
                typeId: input.typeId,
                label: input.label,
                plainValues: plain,
                createdAt: existing?.credential.createdAt ?? new Date().toISOString(),
            },
            encrypted,
            removed
        );
        return id;
    }

    /**
     * Delete a credential and its secrets.
     * @param id The credential.
     */
    async remove(id: string): Promise<void> {
        await this.store.deleteCredential(id);
    }

    /**
     * Decrypt a credential for an adapter.
     * @param id The credential.
     * @returns Values including secrets.
     */
    async resolve(id: string): Promise<ResolvedCredential> {
        const entry = (await this.store.credentials()).find(item => item.credential.id === id);
        if (!entry)
            throw new ApplicationError({
                category: 'authentication',
                retry: { kind: 'after-change', change: 'credential' },
                outcome: 'rejected',
                detail: {
                    provider: 'whim',
                    message: 'The credential for this session was deleted.',
                },
            });
        const values: Record<string, unknown> = { ...entry.credential.plainValues };
        for (const [key, ciphertext] of Object.entries(await this.store.secrets(id)))
            values[key] = await this.cipher.decrypt(ciphertext);
        return { id, typeId: entry.credential.typeId, values };
    }
}
