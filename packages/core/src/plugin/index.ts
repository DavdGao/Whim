import type { ChatCard, DecisionCard, FrozenChatCard, ThinkingLevel } from '../contracts/card.js';
import type {
    Access,
    Block,
    FileVersion,
    NativeToolCallBlock,
    ToolDeclaration,
    ToolResult,
    Usage,
} from '../contracts/records.js';

/**
 * The plugin API version this Core implements, `MAJOR.MINOR` (design.md §5.7). A plugin's
 * `whim.api` must have the same major and a minor no greater than this one.
 */
export const pluginApiVersion = '1.0';

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

/** Media bytes delivered in a request; Core includes only types the card accepts. */
export interface InlineMedia {
    readonly type: 'inline_media';
    readonly mediaType: string;
    /** Base64 of the bytes. */
    readonly data: string;
}

/** Blocks an adapter receives: record blocks with media resolved to bytes or text. */
export type RequestBlock = Exclude<Block, { type: 'media' }> | InlineMedia;

export type ChatRequestMessage =
    | { readonly role: 'user' | 'assistant'; readonly blocks: readonly RequestBlock[] }
    /** One tool result, placed right after the assistant message that called it. */
    | {
          readonly role: 'tool';
          readonly callId: string;
          readonly status: ToolResult['status'];
          readonly content: string;
          /** Only types listed in the session's `toolResultMedia`. */
          readonly media?: readonly InlineMedia[];
      };

export interface ChatRequest {
    readonly system: string;
    readonly messages: readonly ChatRequestMessage[];
    readonly thinking?: ThinkingLevel;
    /** Local tools the model may call. */
    readonly tools: readonly ToolDeclaration[];
    /** Provider tools executed inside this call; the card's `nativeTools` minus separate ones. */
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
    /**
     * Media types the protocol carries inside a tool result. Core promotes other supported
     * media to a user message after the tool results. Absent means none.
     */
    readonly toolResultMedia?: readonly string[];
    /** Optional provider-accurate token count; Core falls back to an estimate. */
    countTokens?(request: ChatRequest, signal: AbortSignal): Promise<number>;
    /**
     * Stream one model attempt. Throws `ApplicationError` on failure, including end of stream
     * without completion. Never retries internally.
     */
    stream(request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;
    /**
     * Run one of the adapter's `separateTools` as its own provider call with this card and
     * credential. Its context is independent of the chat; its usage is the session's. Throws
     * `ApplicationError` on failure. Never retries internally.
     */
    runTool?(
        tool: string,
        input: Readonly<Record<string, unknown>>,
        options: { readonly thinking?: ThinkingLevel; readonly signal: AbortSignal }
    ): Promise<ProviderToolResult>;
}

/** The outcome of a provider-run tool call. */
export interface ProviderToolResult {
    readonly output: ToolOutput;
    /** Reported usage of the provider call; absent fields stay unknown. */
    readonly usage: Usage;
}

export interface ChatAdapter {
    /** `<pluginId>#<name>`, referenced by cards' `adapter` field. */
    readonly id: string;
    readonly kind: 'chat';
    /** Credential type ids this adapter accepts. */
    readonly credentialTypes: readonly string[];
    /** JSON Schema for card `options`. */
    readonly optionsSchema: JsonSchema;
    /**
     * Standard tool ids from a card's `nativeTools` that this adapter runs as separate provider
     * calls through `ChatSession.runTool` rather than inside `stream`. The model sees them as the
     * local tool with the same standard id; Core owns permissions, results, and records.
     */
    readonly separateTools?: readonly string[];
    /** Cross-field card rules beyond the schemas. */
    validateCard?(card: ChatCard): readonly CardIssue[];
    /** Bind a frozen card and credential. Throws `ApplicationError` when the pair is unusable. */
    open(binding: {
        readonly card: FrozenChatCard;
        readonly credential: ResolvedCredential;
    }): ChatSession;
}

/** A question with named options; the answer is one of them. */
export interface ChoiceQuestion {
    readonly type: 'choice';
    readonly instructions: string;
    /** Option name to what it means. */
    readonly options: Readonly<Record<string, string>>;
}

export interface DecisionRequest {
    /** What every question refers to. */
    readonly state: string;
    readonly questions: Readonly<Record<string, ChoiceQuestion>>;
}

export interface ChoiceAnswer {
    readonly type: 'choice';
    /** One of the question's option names. */
    readonly choice: string;
    /** The model's calibrated confidence in `choice`, from 0 to 1. */
    readonly confidence: number;
    readonly probabilities: Readonly<Record<string, number>>;
}

export interface DecisionResult {
    /** One answer per question, keyed like the questions. */
    readonly answers: Readonly<Record<string, ChoiceAnswer>>;
    readonly usage: Usage;
}

/** One Decision adapter binding for a card and a credential. */
export interface DecisionSession {
    /**
     * Answer the questions in one provider call. Throws `ApplicationError` on failure, including
     * an answer that does not match its question. Never retries internally.
     */
    decide(request: DecisionRequest, signal: AbortSignal): Promise<DecisionResult>;
}

export interface DecisionAdapter {
    /** `<pluginId>#<name>`, referenced by cards' `adapter` field. */
    readonly id: string;
    readonly kind: 'decision';
    readonly credentialTypes: readonly string[];
    readonly optionsSchema: JsonSchema;
    /** Bind a card and credential. Throws `ApplicationError` when the pair is unusable. */
    open(binding: {
        readonly card: DecisionCard;
        readonly credential: ResolvedCredential;
    }): DecisionSession;
}

export type ModelAdapter = ChatAdapter | DecisionAdapter;

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
    /** The credential a tool with `credentialType` runs with, decrypted. */
    readonly credential?: ResolvedCredential;
    /**
     * The latest version of each file the model has in context: what tools recorded in `files`
     * since the last compaction, by absolute path. A tool that changes a file requires the file
     * to be unchanged since then, so the model never edits content it has not seen.
     */
    readonly knownFiles: ReadonlyMap<string, FileVersion>;
}

export interface ToolOutput {
    readonly content: string;
    readonly isError?: boolean;
    /** Media returned with the text, such as an image Read opened; Core stores it. */
    readonly media?: readonly {
        readonly mediaType: string;
        readonly data: Uint8Array;
        readonly name?: string;
    }[];
    /** Files the call read or wrote, as they were afterwards (see `ToolContext.knownFiles`). */
    readonly files?: readonly FileVersion[];
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
    /**
     * A credential type the tool needs, such as a search API key. The tool is offered only while
     * the user has a credential of that type, and each call receives the most recent one.
     */
    readonly credentialType?: string;
    /** Everything the call would touch; paths absolute. */
    access(input: Input, env: ToolEnv): readonly Access[];
    /** Foreground limit in milliseconds; 0 starts in the background, undefined never moves. */
    backgroundAfterMs?(input: Input): number | undefined;
    /** Run the call. Throwing is reported to the model as an error result. */
    execute(input: Input, context: ToolContext): Promise<ToolOutput>;
}

/**
 * Long-running work owned by the plugin, independent of windows (design.md §5.7). Started after
 * activation succeeds; `signal` aborts when the plugin stops, and the returned promise must
 * settle soon after. A promise that rejects before then is reported on the plugin.
 */
export interface ServiceDefinition {
    /** Declared in `whim.contributes.services`. */
    readonly id: string;
    start(signal: AbortSignal): Promise<void> | void;
}

/**
 * A request the plugin's own client entry can make. Core validates the input before `handle`
 * and the output after it; `signal` aborts when the plugin stops.
 */
export interface MethodDefinition<Input = unknown, Output = unknown> {
    /** Declared in `whim.contributes.methods`. */
    readonly name: string;
    readonly inputSchema: JsonSchema;
    readonly outputSchema: JsonSchema;
    handle(input: Input, signal: AbortSignal): Promise<Output> | Output;
}

/** A value the plugin's client entry can follow: the latest value, then every change. */
export interface TopicDefinition<Value = unknown> {
    /** Declared in `whim.contributes.topics`. */
    readonly name: string;
    readonly schema: JsonSchema;
    readonly initial: Value;
}

/** Publishes a topic's new value; Core validates it against the topic's schema. */
export interface Topic<Value = unknown> {
    publish(value: Value): void;
}

/** Services a plugin receives for one activation. Registrations are disposed with it. */
export interface PluginContext {
    readonly pluginId: string;
    readonly version: string;
    readonly signal: AbortSignal;
    readonly credentials: { registerType(type: CredentialType): Disposer };
    readonly models: { registerAdapter(adapter: ModelAdapter): Disposer };
    readonly tools: {
        // Plugins type their own input; Core validates it against the schema first.
        register<Input>(tool: ToolDefinition<Input>): Disposer;
    };
    readonly services: { register(service: ServiceDefinition): Disposer };
    /** Calls and subscriptions for the plugin's own client entry, nobody else's. */
    readonly rpc: {
        // Plugins type their own input and output; Core validates both against the schemas.
        method<Input, Output>(method: MethodDefinition<Input, Output>): Disposer;
        topic<Value>(topic: TopicDefinition<Value>): Topic<Value>;
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
