import { ApplicationError } from '../contracts/failure.js';

import type { CredentialService } from './credentials.js';
import type { PluginHost } from './plugin-host.js';
import type { RegisteredAdapter } from './plugin-host.js';
import type { DecisionCard, FrozenChatCard } from '../contracts/card.js';
import type { ChatSession, DecisionSession, ResolvedCredential } from '../plugin/index.js';

/**
 * Report a configuration problem as a non-retryable failure.
 * @param message What is wrong.
 * @returns The error.
 */
function unavailable(message: string): ApplicationError {
    return new ApplicationError({
        category: 'model-unavailable',
        retry: { kind: 'after-change', change: 'configuration' },
        outcome: 'rejected',
        detail: { provider: 'whim', message },
    });
}

/** Binds frozen cards and credentials to registered adapters. */
export class ModelService {
    /**
     * Create the service.
     * @param host Registered adapters.
     * @param credentials Credential resolution.
     */
    constructor(
        private readonly host: PluginHost,
        private readonly credentials: CredentialService
    ) {}

    /**
     * Whether an adapter accepts a credential type.
     * @param adapterId The adapter.
     * @param typeId The credential type.
     * @returns True when compatible.
     */
    accepts(adapterId: string, typeId: string): boolean {
        return this.host.adapters.get(adapterId)?.adapter.credentialTypes.includes(typeId) ?? false;
    }

    /**
     * Open a Chat adapter session for a frozen card and credential.
     * @param card The card fields frozen in the session's epoch.
     * @param credentialId The session's credential.
     * @returns A ready chat session.
     */
    async open(card: FrozenChatCard, credentialId: string): Promise<ChatSession> {
        const { adapter, credential } = await this.#bind(card.adapter, card.options, credentialId);
        if (adapter.kind !== 'chat')
            throw unavailable(`${card.adapter} does not serve chat models.`);
        return adapter.open({ card, credential });
    }

    /**
     * Open a Decision adapter session for a card and credential.
     * @param card The Decision card.
     * @param credentialId The credential to use.
     * @returns A ready decision session.
     */
    async openDecision(card: DecisionCard, credentialId: string): Promise<DecisionSession> {
        const { adapter, credential } = await this.#bind(card.adapter, card.options, credentialId);
        if (adapter.kind !== 'decision')
            throw unavailable(`${card.adapter} does not serve decision models.`);
        return adapter.open({ card, credential });
    }

    /**
     * Find a card's adapter and resolve a credential it accepts.
     * @param adapterId The card's adapter.
     * @param options The card's adapter options.
     * @param credentialId The credential.
     * @returns The adapter and the decrypted credential.
     */
    async #bind(
        adapterId: string,
        options: Readonly<Record<string, unknown>>,
        credentialId: string
    ): Promise<{ adapter: RegisteredAdapter['adapter']; credential: ResolvedCredential }> {
        const registered = this.host.adapters.get(adapterId);
        if (!registered) throw unavailable(`The plugin providing ${adapterId} is not active.`);
        const issues = registered.optionsSchema.issues(options);
        if (issues.length)
            throw unavailable(`The model options are no longer valid: ${issues[0].message}.`);
        const credential = await this.credentials.resolve(credentialId);
        if (!registered.adapter.credentialTypes.includes(credential.typeId))
            throw unavailable('The selected credential does not work with this model.');
        return { adapter: registered.adapter, credential };
    }
}
