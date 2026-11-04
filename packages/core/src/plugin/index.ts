import type { ChatCard, FrozenChatCard, ThinkingLevel } from '../contracts/card.js';
import type { Block, Usage } from '../contracts/records.js';

/** A JSON Schema 2020-12 object. Core validates it before use. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** A disposer returned by every registration. */
export type Disposer = () => void;

export interface CredentialType {
    /** `<pluginId>#<name>`. */
    readonly id: string;
    /** JSON Schema of the credential object. Secret properties use `writeOnly: true`. */
    readonly schema: JsonSchema;
}

/** A credential with secrets decrypted, given only to adapters in Backend. */
export interface ResolvedCredential {
    readonly id: string;
    readonly typeId: string;
    readonly values: Readonly<Record<string, unknown>>;
}

export interface CardIssue {
    readonly path: string;
    readonly message: string;
}

export interface ChatRequestMessage {
    readonly role: 'user' | 'assistant';
    readonly blocks: readonly Block[];
}

export interface ChatRequest {
    readonly system: string;
    readonly messages: readonly ChatRequestMessage[];
    readonly thinking?: ThinkingLevel;
}

/** Normalized stream events. A stream ends with exactly one `completed` event or throws. */
export type ChatEvent =
    | { readonly type: 'text-delta'; readonly text: string }
    | { readonly type: 'reasoning-delta'; readonly text: string }
    | { readonly type: 'continuation'; readonly format: number; readonly data: unknown }
    | { readonly type: 'completed'; readonly usage: Usage };

/** One adapter binding for a frozen card and a credential. */
export interface ChatSession {
    /** Largest input, in tokens, the adapter will send for this card. */
    inputBudget(): number;
    /** Optional provider-accurate token count; Core falls back to an estimate. */
    countTokens?(request: ChatRequest, signal: AbortSignal): Promise<number>;
    /**
     * Stream one model attempt. Throws `ApplicationError` on failure, including end of stream
     * without completion. Never retries internally.
     */
    stream(request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;
}

export interface ChatAdapter {
    /** `<pluginId>#<name>`, referenced by cards' `adapter` field. */
    readonly id: string;
    readonly kind: 'chat';
    /** Credential type ids this adapter accepts. */
    readonly credentialTypes: readonly string[];
    /** JSON Schema for card `options`. */
    readonly optionsSchema: JsonSchema;
    /** Cross-field card rules beyond the schemas. */
    validateCard?(card: ChatCard): readonly CardIssue[];
    /** Bind a frozen card and credential. Throws `ApplicationError` when the pair is unusable. */
    open(binding: {
        readonly card: FrozenChatCard;
        readonly credential: ResolvedCredential;
    }): ChatSession;
}

/** Services a plugin receives for one activation. Registrations are disposed with it. */
export interface PluginContext {
    readonly pluginId: string;
    readonly version: string;
    readonly signal: AbortSignal;
    readonly credentials: { registerType(type: CredentialType): Disposer };
    readonly models: { registerAdapter(adapter: ChatAdapter): Disposer };
}

export interface PluginDefinition {
    activate(context: PluginContext): Promise<void> | void;
    deactivate?(): Promise<void> | void;
}

/**
 * Declare a plugin's host entry; the default export of the `host` module.
 * @param definition The plugin lifecycle.
 * @returns The same definition, typed.
 */
export function definePlugin(definition: PluginDefinition): PluginDefinition {
    return definition;
}
