import type { ChatCard, FrozenChatCard, ThinkingLevel } from '../contracts/card.js';
import type {
    Access,
    Block,
    NativeToolCallBlock,
    ToolDeclaration,
    ToolResult,
    Usage,
} from '../contracts/records.js';

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

export type ChatRequestMessage =
    | { readonly role: 'user' | 'assistant'; readonly blocks: readonly Block[] }
    /** One tool result, placed right after the assistant message that called it. */
    | {
          readonly role: 'tool';
          readonly callId: string;
          readonly status: ToolResult['status'];
          readonly content: string;
      };

export interface ChatRequest {
    readonly system: string;
    readonly messages: readonly ChatRequestMessage[];
    readonly thinking?: ThinkingLevel;
    /** Local tools the model may call. */
    readonly tools: readonly ToolDeclaration[];
    /** Native tool ids the provider executes; a subset of the card's `nativeTools`. */
    readonly nativeTools: readonly string[];
}

/** Normalized stream events. A stream ends with exactly one `completed` event or throws. */
export type ChatEvent =
    | { readonly type: 'text-delta'; readonly text: string }
    | { readonly type: 'reasoning-delta'; readonly text: string }
    | { readonly type: 'continuation'; readonly format: number; readonly data: unknown }
    /** A complete local tool call; emitted only once its arguments are final. */
    | {
          readonly type: 'tool-call';
          readonly callId: string;
          readonly name: string;
          readonly arguments: string;
      }
    /** A provider-executed tool call, for display and replay. */
    | ({ readonly type: 'native-tool-call' } & Omit<NativeToolCallBlock, 'type' | 'adapter'>)
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

/** Environment a tool needs to resolve paths. */
export interface ToolEnv {
    readonly workspace?: string;
}

/** Services one tool execution receives. */
export interface ToolContext extends ToolEnv {
    /** Aborted by Stop for foreground calls and by JobStop for background ones. */
    readonly signal: AbortSignal;
    readonly sessionId: string;
    readonly callId: string;
    /** Append progressive output, readable through JobOutput while the job runs. */
    output(chunk: string): void;
}

export interface ToolOutput {
    readonly content: string;
    readonly isError?: boolean;
}

/**
 * A local tool. Core validates input against `inputSchema` before calling `access` or
 * `execute`, decides permissions from `access`, and owns jobs, truncation, and records.
 */
export interface ToolDefinition<Input = Record<string, unknown>> {
    /** Model-facing name, unique across plugins: letters, digits, `_` and `-`, at most 64. */
    readonly name: string;
    readonly description: string;
    readonly inputSchema: JsonSchema;
    readonly readOnly: boolean;
    readonly concurrencySafe: boolean;
    /** Offered only to sessions with a workspace. */
    readonly needsWorkspace: boolean;
    /** Local implementation of a standard tool id that a model may also provide natively. */
    readonly standard?: 'web_search' | 'web_fetch';
    /** Everything the call would touch; paths absolute. */
    access(input: Input, env: ToolEnv): readonly Access[];
    /** Foreground limit in milliseconds; 0 starts in the background, undefined never moves. */
    backgroundAfterMs?(input: Input): number | undefined;
    /** Run the call. Throwing is reported to the model as an error result. */
    execute(input: Input, context: ToolContext): Promise<ToolOutput>;
}

/** Services a plugin receives for one activation. Registrations are disposed with it. */
export interface PluginContext {
    readonly pluginId: string;
    readonly version: string;
    readonly signal: AbortSignal;
    readonly credentials: { registerType(type: CredentialType): Disposer };
    readonly models: { registerAdapter(adapter: ChatAdapter): Disposer };
    readonly tools: {
        // Plugins type their own input; Core validates it against the schema first.
        register<Input>(tool: ToolDefinition<Input>): Disposer;
    };
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

/**
 * Type a tool definition against its input type.
 * @param tool The definition.
 * @returns The same definition.
 */
export function defineTool<Input>(tool: ToolDefinition<Input>): ToolDefinition<Input> {
    return tool;
}
