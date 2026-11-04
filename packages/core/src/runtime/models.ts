import { ApplicationError } from '../contracts/failure.js';

import type { CredentialService } from './credentials.js';
import type { PluginHost } from './plugin-host.js';
import type { FrozenChatCard } from '../contracts/card.js';
import type { ChatSession } from '../plugin/index.js';

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
        return (
            this.host.chatAdapters.get(adapterId)?.adapter.credentialTypes.includes(typeId) ?? false
        );
    }

    /**
     * Open an adapter session for a frozen card and credential.
     * @param card The card fields frozen in the session's epoch.
     * @param credentialId The session's credential.
     * @returns A ready chat session.
     */
    async open(card: FrozenChatCard, credentialId: string): Promise<ChatSession> {
        const registered = this.host.chatAdapters.get(card.adapter);
        if (!registered) throw unavailable(`The plugin providing ${card.adapter} is not active.`);
        const issues = registered.optionsSchema.issues(card.options);
        if (issues.length)
            throw unavailable(
                `The session's card options are no longer valid: ${issues[0].message}.`
            );
        const credential = await this.credentials.resolve(credentialId);
        if (!registered.adapter.credentialTypes.includes(credential.typeId))
            throw unavailable('The selected credential does not work with this model.');
        return registered.adapter.open({ card, credential });
    }
}
