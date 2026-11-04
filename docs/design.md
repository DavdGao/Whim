# Whim Application Design

Status: implementation specification, not a statement of completed functionality. Last updated: 2026-11-04.

This document defines Whim's architecture, module boundaries, interface semantics, and data invariants. A change to these decisions must update this document and explain the reason in the same change. Interface examples describe the intended contracts; exact types will be refined during implementation. Features marked as later work are outside the first release.

## 1. Goals and initial scope

Whim is a macOS-only Electron application combining personal chat, coding sessions, information subscriptions, music, and dashboard widgets in one workspace. Pages are views over application capabilities; navigating between them must not terminate background work. Whim owns its main chat independently of external coding agents connected through ACP.

The first release delivers a minimal, recoverable end-to-end system:

- An Electron and React interface using shadcn/ui, Tailwind CSS, and lucide-react, with English and Simplified Chinese language options.
- TypeScript plugins with a shared release version.
- DashScope Chat through the OpenAI Responses-compatible protocol.
- DashScope Decision through the TypeSafe System One-compatible protocol.
- Main chat, model and plugin settings, and per-call token accounting.
- One SQLite database with a complete append-only agent journal: messages, state, tasks, compaction, execution facts, and durable deliveries.
- Stable record IDs and ordered session positions that preserve the option of future forks.
- OpenTelemetry tracing for agent runs and model calls, independent of durable execution.
- An activity index containing operation types and object references without copies of content or duplicate outcome state.

The first release excludes TTS, ASR, vector storage, monetary cost calculations, a generic model-constraint engine, distributed execution, plugin sandboxing, a plugin marketplace, and production code hot swapping. ACP, information sources, music, and dashboard widgets are subsequent integrations with defined extension boundaries.

A local main chat means that Whim owns the conversation and execution lifecycle. Model inference still runs through DashScope.

## 2. Principles

1. **The database is the source of truth for durable business state.** In-memory queues, context views, and UI state may be lost. Accepted input, pending work, and committed results must be recoverable.
2. **The agent journal is append-only.** Messages, state transitions, tasks, compaction, and execution facts are immutable records. Agent views and mutable scheduling projections are rebuildable. Global activity stays a minimal operation index; unrelated application settings do not require a general event-sourcing framework.
3. **Commit before acknowledgment and external execution.** Persist accepted input and execution intent before confirming submission. Persist tool identity and arguments before performing external effects.
4. **Notifications may be lost; work must survive.** IPC provides wakeups and live presentation. The database determines what remains to be processed.
5. **Activity indexes reference content.** Message bodies belong to conversations; collected content belongs to source items. Activity entries reference their owning records.
6. **Separate protocol, capability, and connection.** A provider name alone does not determine an API, model capability, or account availability.
7. **Design package, process, and session boundaries separately.** A package is not a process, and a session is not a thread.
8. **Default to async execution with explicit ownership.** I/O uses native asynchronous interfaces. Background work has a lifetime, cancellation signal, concurrency limit, and result owner.
9. **Define interfaces at replaceable boundaries.** Models, tools, external services, execution hosts, and storage ports need contracts. Ordinary internal functions do not need service wrappers.
10. **Establish recovery semantics before optimizing.** Verify transactions, deduplication, and crash recovery before adding batching, caches, or additional workers.

The source-of-truth rule does not require persisting every mouse event, HTTP byte, or streamed token. Uncommitted stream fragments, open connections, and transient presentation state may be lost. Credentials live in macOS Keychain, with references in the database; Keychain is a credential boundary rather than another business database.

## 3. Packages and dependencies

Use a pnpm workspace with four foundational packages and plugins for concrete external capabilities. Contracts remain inside core; plugin SDK, host, and SQLite implementation are modules rather than additional packages.

| Directory / package                   | Responsibility                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `apps/desktop`                        | Electron main, preload, and React renderer; process creation and implementation assembly                     |
| `packages/core` / `@whimkit/core`     | Commands, queries, plugin lifecycle, durable execution, messaging, SQLite storage, and public business types |
| `packages/models` / `@whimkit/models` | Model cards, Chat/Decision types, capability validation, and adapter contracts; no persistence               |
| `packages/agent` / `@whimkit/agent`   | Main-chat loop, context construction, and tool scheduling through injected ports                             |
| `packages/ui` / `@whimkit/ui`         | Shared shadcn components, themes, UI slots, data hooks, and presentation components                          |
| `packages/plugin-dashscope`           | One provider plugin with independent Chat and Decision adapters and model cards                              |

These are target packages, not a claim that the current repository already implements them. Use `models` for model contracts and adapters; do not maintain parallel `llm` and `models` abstractions.

Core exposes subpaths according to runtime boundaries:

- `@whimkit/core`: browser-safe business types and schemas.
- `@whimkit/core/plugin`: plugin definitions and host capability interfaces.
- `@whimkit/core/client`: typed clients for renderer code.
- `@whimkit/core/runtime`: Node runtime, storage, and scheduling implementations.

Models does not depend on Electron or core runtime. Core's model service uses models contracts. Agent depends on models and core ports; core does not import agent. Desktop assembles the system and injects the agent runner into core. Plugins use public contracts rather than importing another plugin's implementation. UI code does not import Node implementations.

Main chat, settings, reader, and coding pages initially live in desktop feature directories. Independent installation or replacement is the reason to create a plugin package.

UI actions and agent tools share three application interfaces:

- `command({ operationId, type, input, expectedVersion? })` submits a change and returns a durable receipt.
- `query({ type, input })` reads paginated projections or facts.
- `subscribe({ topic, afterSeq? }, signal)` observes changes.

Public schemas define the types and runtime IPC validation. A receipt confirms acceptance of input and work, while later execution state reports completion. Reconnection obtains a snapshot with a sequence position and catches up on committed records after that position, avoiding gaps between querying and subscribing.

## 4. Processes, threads, and asynchronous execution

The first release has three application-level processes: Electron Main, Renderer, and one Backend utility process. Backend hosts Core, the agent runner, and trusted backend plugin entries. One DB worker thread inside Backend runs SQLite. Electron and Node manage additional internal execution units; these are ownership boundaries rather than an exact OS thread count.

The topology keeps presentation independent of business execution without a separate plugin RPC layer.

```mermaid
flowchart TB
    Main["Electron Main: windows, system integration, supervision"]
    UI["Renderer: React pages and plugin client entries"]
    subgraph Backend["Backend utility process"]
        Runtime["Core, agent runner, scheduler, plugin host entries"]
        DBWorker["Dedicated DB worker thread"]
        Runtime <-->|Async storage operations| DBWorker
    end
    DB[("One SQLite database")]
    Remote["DashScope and later external services"]
    Main --> UI
    Main --> Runtime
    UI <-->|Preload and typed IPC| Runtime
    DBWorker --> DB
    Runtime <-->|Native async I/O| Remote
```

Main owns windows, menus, Keychain access, updates, and Backend supervision. Renderer uses context isolation with Node integration disabled. Preload exposes validated application operations rather than arbitrary IPC, SQL, or Node access.

Backend services and trusted plugin host entries use ordinary typed calls. Model requests are concurrent async tasks, not one thread per call. A session has at most one context-advancing runner. Different sessions, plugin workloads, and model connections have bounded concurrency; work waiting for capacity remains durable.

Network calls use native async I/O, files use `fs/promises`, and external programs use asynchronous spawn. Operations propagate AbortSignal and have owned cleanup. Streams use AsyncIterable with bounded buffers, explicit terminal/error events, and cancellation. Navigation releases subscriptions without canceling business work. A subscriber does not change an in-flight request's streaming mode.

The synchronous SQLite driver, initially `better-sqlite3`, runs only in the DB worker. Store methods return promises; each short transaction is one worker request with no network waits. A caller timeout does not prove rollback: check the operation ID before retrying. Pin and validate the driver in Electron's actual runtime.

A trusted plugin can block or crash Backend. This failure domain is accepted for the first bundled adapters; it is not a permission sandbox. Main can restart Backend and recover committed state. A DB worker failure stops new work until storage is reconciled. A native crash may terminate the whole Backend. External requests already sent remain subject to unknown-outcome handling.

Add bounded CPU workers or a dedicated plugin process only when measured workloads or failure isolation require them. Host-managed subprocesses belong to a plugin/run scope. Do not allocate a process merely because another package, plugin, or session exists.

Shutdown stops admission, drains or cancels tasks, disposes plugins, and closes storage last. Closing the window hides it while work continues; explicit application exit stops execution.

Implementation references: [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process), [Node workers](https://nodejs.org/api/worker_threads.html), [better-sqlite3](https://github.com/WiseLibs/better-sqlite3).

## 5. Plugins

### 5.1 One package, separate runtime entries

A plugin is one versioned npm package, not one execution environment. It may contain a backend `host` entry, a frontend `client` entry, both, and optional styles. Host code runs in Backend; client code runs in Renderer. They communicate through typed commands, queries, and subscriptions, never shared mutable memory or direct Node access from UI.

A plugin can therefore provide a settings panel, invoke backend work, and stream progress to a custom view. Host and client activation/disposal are separate; unmounting a client view does not stop its backend task.

The manifest identifies the entries without requiring a package per entry.

```json
{
    "name": "@whimkit/plugin-dashscope",
    "version": "0.1.0",
    "type": "module",
    "whim": {
        "manifestVersion": 1,
        "host": "./dist/host.js"
    },
    "peerDependencies": {
        "@whimkit/core": "0.1.0",
        "@whimkit/models": "0.1.0"
    }
}
```

A plugin with UI adds `client` and `styles` paths. Author entries in TS/TSX and publish ESM, declarations, and compiled styles. The initial DashScope plugin registers separate Chat and Decision adapters. Shared packaging does not merge their protocols or interfaces.

Initially plugins ship with the application. Keep manifest validation and loading, but defer runtime npm installation, a marketplace, and arbitrary remote UI bundles. A bundled test fixture will verify a plugin with both entries before that contract is relied on.

### 5.2 Registration and ownership

The initial host API exposes model registration, scoped command/query registration, and owned task/disposal facilities. Core owns persistence and model invocation accounting. The initial provider plugin does not need a general-purpose plugin database API or public message bus.

Plugin dependencies name capabilities, not implementation imports. Validate versions, configuration, dependencies, and cycles. Await activation and publish registrations only after success; dispose partial resources on failure.

Application, plugin, session, run, and UI-subscription scopes define ownership. Every listener, timer, connection, and subprocess has a disposer. Background promises are tracked. Observe-only events do not provide durable delivery.

A plugin's installed code, desired enabled state, and actual availability are distinct. Disable first stops admission, then drains/cancels work and releases resources in reverse dependency order. Business history remains. Uncooperative host code may require restarting Backend; uncooperative client code may require reloading Renderer.

### 5.3 Configuration and upgrades

A running attempt retains its prepared configuration snapshot and adapter generation. Settings changes affect subsequent preparation. Package upgrades activate after restart, not production hot swapping.

Recovery never silently executes an old plan against incompatible code. An incompatible pending plan is blocked; an explicit replan appends a new plan with its new version and reason. Interrupted attempts retain their terminal/unknown facts. No live request or unreconciled external effect is blindly replayed after an upgrade.

When an information-source plugin first needs private durable data, define its schema ownership, migration, decoding after uninstall, and commit boundary with that feature. Do not introduce an arbitrary namespaced data store beforehand.

## 6. Models and adapters

### 6.1 Identity layers

Every invocation distinguishes four identities:

| Concept    | Example                                                | Meaning                                          |
| ---------- | ------------------------------------------------------ | ------------------------------------------------ |
| Provider   | `dashscope`                                            | Service vendor                                   |
| Adapter    | `dashscope-responses` or `dashscope-systemone`         | Protocol conversion and vendor-specific behavior |
| ModelCard  | A concrete model under an adapter, with a revision     | Capabilities exposed on that invocation route    |
| Connection | A regional workspace endpoint and credential reference | The user's configured access path                |

A model ID alone does not establish identical capability across regions, APIs, or accounts. Effective capability is the intersection of the card, implemented adapter behavior, connection configuration, and known restrictions. Authentication, connectivity, rate limits, and availability are tracked separately from the static card.

### 6.2 Model cards

Every model, including Decision, has a card. Cards contain identity, capabilities, limits, and evidence. They contain no prices, currencies, rates, cost estimates, or billing rules. The first release has Chat and Decision variants only.

The draft below retains unknown capabilities explicitly.

```ts
type Support = 'supported' | 'unsupported' | 'unknown';
type Modality = 'text' | 'image' | 'audio' | 'video';

interface ModelCardBase {
    id: string;
    revision: number;
    provider: string;
    adapterId: string;
    modelId: string;
    label: string;
    status: 'active' | 'deprecated' | 'unknown';
    inputModalities: readonly Modality[];
    outputModalities: readonly Modality[];
    contextTokens: number | null;
    evidence: { source: string; checkedAt: string };
}

interface ChatModelCard extends ModelCardBase {
    kind: 'chat';
    maxOutputTokens: number | null;
    capabilities: {
        streaming: Support;
        tools: Support;
        structuredOutput: Support;
        thinking: Support;
        webSearch: Support;
        webFetch: Support;
    };
}

interface DecisionModelCard extends ModelCardBase {
    kind: 'decision';
    questionTypes: readonly ('choice' | 'score' | 'noul')[];
    maxQuestions: number | null;
    maxChoices: number | null;
    maxScoreLevels: number | null;
}

type ModelCard = ChatModelCard | DecisionModelCard;
```

Decision returns structured decisions rather than generated prose. Its output modalities may be empty; `kind` and `questionTypes` define the result shape. Do not invent a generative output-token limit. Initial inputs are text or JSON state, and Chat initially implements the text path. Other modality names in the type do not imply implemented transport support.

`webSearch` and `webFetch` describe native API capabilities. Installing an application search tool does not mark every model as supporting native search. Cards reflect what the adapter actually exposes, not merely what an upstream service could support.

Later additions may include MIME restrictions, thinking effort/budget, mandatory thinking, structured-output/thinking exclusions, and required or forbidden streaming. The first release does not build a generic constraint DSL. Adapters must still reject known invalid combinations and expose only verified parameter combinations. Unsupported configuration produces an explicit error instead of silently changing request semantics.

### 6.3 Asynchronous invocation

Chat and Decision share discovery and preparation but have separate call contracts. Preparation freezes the card, connection and adapter versions, and effective parameters into a durable call plan. Runtime handles themselves are not persisted.

```ts
interface ChatAdapter {
    generate(request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;
}

interface DecisionAdapter {
    evaluate(request: DecisionRequest, signal: AbortSignal): Promise<DecisionResult>;
}

interface TokenUsage {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
}
```

Chat events distinguish text/thinking deltas, complete output items, completion, failure, and final usage. A non-streaming HTTP response can become one complete result followed by a terminal event, avoiding a second agent loop. An interrupted stream is not committed as a successful answer merely because it reached EOF.

Decision requests contain `state` and questions keyed by ID. Answers form a discriminated union: a choice, a score with its scale, or a noul probability. Preserve returned distributions and confidence. Business callers choose any threshold that converts noul into a boolean. Confidence is not treated as an empirically calibrated correctness rate.

### 6.4 Initial protocol routes

The adapters use the following routes. These contracts require live verification against the selected account before release.

| Plugin                              | Protocol and path                                         | Implementation                                                                                                               |
| ----------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `plugin-dashscope` Chat adapter     | OpenAI Responses: `POST /compatible-mode/v1/responses`    | Async Responses calls through the OpenAI TypeScript SDK with a DashScope base URL; vendor extensions stay inside the adapter |
| `plugin-dashscope` Decision adapter | TypeSafe System One: `POST /compatible-mode/v1/systemone` | Native fetch with the JSON protocol and typed decision semantics                                                             |

Connections store region, workspace, and base URL explicitly. The initial Decision card targets the documented `decision-model-preview` route in Beijing or Singapore, subject to account availability. [DashScope Decision API](https://docs.bailian.console.aliyun.com/en/model-studio/decision-model-api).

Chat starts with a small verified card set rather than assuming complete Responses support across the provider's catalog. SDK types do not establish service support for every field. The adapter does not silently fall back to Chat Completions. Disable implicit SDK retries so the runtime owns attempt accounting. [DashScope Responses API](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-responses).

Main chat constructs input from local records on every request and uses `store: false`. Recovery does not require `previous_response_id` or remote Conversations. Preserve the item IDs, call IDs, reasoning information, and other supported fields needed for continuation; storing only `output_text` is insufficient. Each adapter follows its endpoint's rules for replaying items. [Responses protocol guidance](https://developers.openai.com/api/docs/guides/migrate-to-responses).

### 6.5 Token accounting

Every actual model request has its own attempt ID and associated usage. This includes main chat, Decision, retries, and compaction calls. Preserve reported usage even when a request fails.

- Store reported input, output, total, reasoning, and cached-input tokens. Missing fields remain unknown rather than becoming zero.
- Reasoning and cached-input counts are breakdowns of their respective totals where the protocol defines them that way; do not add them again.
- If total usage is absent but input and output are both known, derive their sum. Otherwise display known counts and completeness separately.
- The initial Decision route reports input tokens only. Do not fabricate output tokens or a complete total.
- Deduplicate usage by attempt. Distinct attempts remain distinct consumption even when they belong to one logical operation.
- Interrupted streams and crashes may lose provider usage. Report the number of incompletely measured attempts rather than claiming exact provider reconciliation.
- Keep context-size estimates separate from historical consumption. Retried or discarded inputs do not accumulate into the next request's context length.

Latency, error codes, and retry counts may be recorded as operational information. No monetary accounting is performed.

## 7. Storage and data ownership

### 7.1 Complete agent journal, minimal global activity

The agent journal must preserve messages, execution state, tasks, context compaction, and the facts needed to recover them. This is a full append-only agent state model, not a message table with mutable state stored elsewhere. Ordinary global activity has a different purpose: an atomic operation index without logical content.

The initial storage uses typed tables and explicit transaction methods. It does not require a general event-sourcing engine for every application feature.

| Data                        | Content and authority                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent records               | Immutable message content, context references, state transitions, task revisions, compaction, plans, attempt/effect outcomes, usage, and delivery facts |
| Session metadata            | Immutable creation and future fork origin; current state/head/task views are rebuildable projections                                                    |
| Pending input and work      | References to accepted input and scheduled work; consumption and completion derive from committed facts                                                 |
| Configuration revisions     | Immutable versions referenced by calls; a current-version pointer may change                                                                            |
| Activity                    | Atomic operation type, timestamp, actor, correlation ID, and optional immutable target reference; no payload                                            |
| Blobs and artifact metadata | Immutable imported/generated content and references, in the same SQLite database                                                                        |
| Schema migrations           | Applied storage versions, independent of application releases                                                                                           |

Diagnostic traces are not authoritative state. Query indexes and usage totals are rebuildable. Credentials live in Keychain; database records contain references, not secrets.

### 7.2 Record identity, sequence, and context

Every record has a globally unique stable ID and a monotonic sequence within its originating session. IDs support references; sequences support ordered folding and prefix selection. Neither is a UI array index or a timestamp.

The envelope makes those responsibilities explicit.

```ts
interface AgentRecord<Body> {
    id: string;
    sessionId: string;
    seq: string;
    schemaVersion: number;
    type: string;
    operationId: string;
    runId?: string;
    attemptId?: string;
    causationId?: string;
    createdAt: string;
    body: Body;
}

interface RecordRef {
    recordId: string;
}
```

SQLite stores sequence numbers as 64-bit integers; transport uses decimal strings. A separate database change cursor may support subscriptions, but is not a branch or context identifier. Assign sequence numbers inside the append transaction. Existing sequences and record IDs never change.

Entry and Block express model-neutral content: role, text, thinking, tool calls/results, and artifact references. Keep protocol continuation fields in adapter-versioned metadata. Store content once; inbox deliveries and context inclusion reference its record.

An accepted input record makes the user's text durable immediately. A separate context-inclusion fact says when a runner actually consumed it. Thus a message accepted during generation can be visible as queued without appearing retrospectively in that request's context. Call plans preserve ordered context references and prompt/tool/configuration revisions.

### 7.3 State, tasks, and compaction

The journal includes these record families from the agent implementation stage:

- Session/run state changes, cancellation, interruption, and blocked/unknown outcomes.
- Accepted messages and context inclusion, assistant output, tool intent and results.
- Task creation, updates, completion, and removal intent under stable task IDs. Previous task revisions remain.
- Model plans and attempts, actual token usage, and effect facts.
- Compaction records containing summary content or references, the exact covered context, the retained tail boundary, and the request/configuration used to produce the summary.

A deterministic fold produces the context View, task view, and state. Mutable projections never become their sole source. Compaction changes the model context only; it does not remove original history, tasks, state, or usage. Subsequent summaries specify the prior summary and additional context they replace. Never split a tool-call/result pair or drop required protocol continuation data.

Compaction is a model call with its own attempt, usage, and trace. Commit its summary and resulting context selection atomically. If it fails or is interrupted, the previous context remains authoritative. If no legal request fits, block with a clear reason rather than silently truncate.

A checkpoint is an optional versioned cache of a fold at a known sequence. It is not a summary or a replacement for the journal. First implement full replay; add checkpoints only when measured replay time requires them.

### 7.4 Future forks

Reserve an immutable fork origin: `parentSessionId`, `parentSeq`, and the cutoff record ID. A child sees the parent's fixed prefix through that cutoff, followed by its own append-only tail. The first child-owned sequence follows the inherited cutoff; parent writes after the cutoff never appear in the child. Globally unique IDs remain valid across inherited history.

Forking reconstructs context and tasks at the selected point, not the parent's current projection. A compaction after the cutoff does not affect the child. Original history remains available even when the selected point predates compaction.

The first fork implementation will allow committed, quiescent turn boundaries. It starts a new execution identity and appends the child's initial state; it does not inherit active runners, pending deliveries, or authorization to repeat historical side effects. Reused historical usage is not charged again in aggregate consumption. UI and API implementation can follow later, but the initial schema and fold must not renumber history or preclude this behavior.

### 7.5 Atomic global activity

An activity entry has an ID, operation type, timestamp, actor, operation correlation ID, and optional session/plugin/target reference. It has no body, prompt, task description, file content, arbitrary metadata, or separate execution-result state machine.

For example, `chat.input.accepted` points to the input record and `settings.updated` points to a configuration revision. Query the referenced execution if its latest outcome is needed. This avoids a second, incomplete copy of succeeded/failed/cancelled/unknown states.

Unsent drafts, pointer/keyboard traces, and scroll positions are not captured. Activity does not observe operations outside integrations owned by Whim. A reference does not itself grant access to the referenced content.

## 8. Transactions and recovery

### 8.1 Input, execution ownership, and completion

Input acceptance atomically stores its immutable content, queue intent, activity reference, and necessary projections before returning a receipt. Repeating an operation ID with identical input returns the receipt; different input under the same ID is a conflict.

Each session has one context-advancing runner. New user input queues FIFO for the next turn; it does not modify an already prepared turn. Explicit cancellation is a separate operation. Future mid-turn steering requires its own contract.

Separate three concepts:

- Journal head: where new facts append.
- Context snapshot: the immutable input references selected for this request.
- Execution generation: which run/attempt may still complete or launch successor work.

New input can advance the journal without invalidating the active attempt. Completion validates the run/generation and deduplicates its attempt, then appends at the current head. A local head conflict must not trigger another model request. Settings/task edits use their own object revisions where needed.

Core owns a narrow `completeWork` transaction: validate ownership, append output and relevant business facts, acknowledge the deliveries belonging to that work, create successor work, and update projections. Plugins return validated results; they cannot claim atomicity by separately calling data-write and message-ack APIs.

Actual reported usage remains a fact even if cancellation makes an answer ineligible to advance the conversation. Late results must not start tools or successor work after losing execution ownership.

### 8.2 Model and tool boundaries

Persist a call plan and attempt start before invoking the model outside the transaction. A complete response commits its output, usage, outcome, and tool intents. Only committed tool intents may execute; tool results commit before the next model request.

A complete response is the initial persistence unit. Live deltas may be lost on crash and must be presented as uncommitted. Reconnection can use Backend's partial buffer while it survives; after a crash, preserve the interrupted attempt and distinguish a retry as a new attempt.

A message's final content, state, tasks, and compaction are durable facts even though individual stream deltas are not. Durable partial output would require an explicit additional protocol.

### 8.3 Deliveries and external effects

Internal inbox delivery is at least once with idempotent completion. Persist the body once and reference it from deliveries. Advance a contiguous consumption cursor only over acknowledged work; use per-delivery acknowledgment if consumption becomes non-contiguous. Startup and reconciliation scan durable pending work; notifications are wakeups.

Persist an external effect's intent and stable ID before dispatch. Outcomes are succeeded, failed, cancelled-before-dispatch, or unknown. A timeout or cancellation after dispatch does not establish remote rollback. Reconcile by remote query or a supported idempotency key; otherwise block unknown side effects rather than automatically repeat them.

Database-local mutations and their result can share a transaction. Remote HTTP, subprocesses, and workspace writes cannot share SQLite's transaction. Record their uncertainty rather than claiming global exactly-once execution.

### 8.4 Restart and upgrades

Restart reconstructs agent state, tasks, and context from the journal before dispatch. Invalidate old execution ownership and reconcile started work. A blocked or incompatible call plan is never silently interpreted with new code/configuration; append an explicit replacement plan if resumed.

Backend or DB worker recovery must query operation IDs where a transaction's response was lost. UserData backup and schema migration complete before work is admitted. Uninstalling a plugin does not delete its history. Business tombstones hide objects; permanent erasure is a separate explicit maintenance operation.

## 9. Database choice

### 9.1 SQLite configuration

Use one local SQLite database with WAL, foreign keys, a busy timeout, and `synchronous=FULL` as the initial acknowledged-write durability policy. Keep write transactions short and serialized. Paginate reads and avoid long transactions that prevent WAL checkpoint progress. Do not put the live database on a network filesystem or directly synchronize it between devices.

WAL and SHM files belong to the same logical database. Backups use a consistent backup mechanism, not a copy of the main file while the database is active. Create a recoverable backup before schema upgrades and finish migration before admitting writes. Binary rollback does not automatically make schema downgrade safe. [SQLite WAL](https://www.sqlite.org/wal.html).

### 9.2 PostgreSQL tradeoffs

SQLite is the initial choice for local desktop deployment. PostgreSQL becomes relevant when shared remote access or sustained concurrent writers justify an additional database service.

| Concern           | SQLite                                                  | PostgreSQL                                                                            |
| ----------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Deployment        | Embedded storage without a separate server              | Server distribution or installation, cluster initialization, and lifecycle management |
| Writes            | One writer at a time with short serialized transactions | Concurrent connections, row locks, and MVCC for independent writers                   |
| Durable messaging | Tables, IPC wakeups, and reconciliation                 | Tables, LISTEN/NOTIFY wakeups, and reconciliation                                     |
| Queries           | Local relational queries, JSON, and FTS5                | JSONB, richer indexing, and multi-client querying                                     |
| Process access    | Centralized through Core's DB worker                    | Independent processes can hold connections and transactions                           |
| Operations        | Backups, migrations, and WAL management                 | Also server resources, authentication, connections, and major-version upgrades        |
| Remote sharing    | Requires an application service                         | Client/server access, still requiring application permissions and conflict semantics  |

Notifications remain wakeups, not durable messages, with either database. Bundling a PostgreSQL server does not remove lifecycle and upgrade responsibilities. [SQLite deployment guidance](https://www.sqlite.org/whentouse.html), [PostgreSQL NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html), [server operation](https://www.postgresql.org/docs/current/runtime.html), [upgrades](https://www.postgresql.org/docs/current/upgrading.html).

Reconsider the choice when measurements show sustained writer contention affecting interaction, when independent executors need concurrent writes, or when remote shared storage becomes an explicit requirement. Do not implement two Stores or a generic SQL abstraction for a hypothetical migration.

Keep semantic ports such as `commit`, `loadSession`, `claimWork`, and `ackDelivery`. A future migration preserves record, entry, and effect semantics while redesigning transaction locking and consumption order. PostgreSQL sequence allocation does not establish commit order, so SQLite cursor assumptions must be revalidated. A migration replaces the authoritative database rather than introducing SQLite/PostgreSQL dual-master synchronization.

## 10. Frontend and main chat

React pages use shared shadcn components, Tailwind tokens, and lucide-react icons from the UI layer. English is the source language for the project. The frontend must offer English (en) and Simplified Chinese (zh-CN), with a persisted language selector available from the initial application shell. Use typed translation keys for all application and plugin UI strings, including errors, accessibility labels, and empty/loading states. Do not translate user content or model output implicitly. Missing keys fall back to English; validate both catalogs for matching keys. Hooks supply query state; commands submit mutations. Components do not access storage or plugin backends directly. Core owns state shared across pages; unmounting a component only releases subscriptions.

The main-chat agent invokes Chat through the model service. Decision is an independent capability available when needed; a decision call is not mandatory before every chat turn. Agent tools and UI operations share command services.

Later tools such as `searchActivity`, `readRecord`, and `listSessions` provide selective access to recorded application data. Do not inject the entire database into each prompt. Access follows tool and permission boundaries; finding an activity reference does not itself authorize reading its content.

Frontend plugins register named route, card, and settings slots with removable registrations. They do not mutate host DOM directly. The full client-plugin loader can be implemented with the first UI plugin; initial model settings may use host-rendered schema forms.

Dynamically installed UI artifacts resolve shared React and UI modules from the host. Plugin styles are precompiled and scoped, reuse host tokens, and avoid duplicate global preflight rules. The host's build cannot depend on scanning source files from packages installed later.

## 11. Later capability boundaries

These contracts define extension direction. Complete their fields before implementing each capability; do not publish empty implementations.

| Capability          | Intended operations                                        | Ownership and limits                                                                                                                                 |
| ------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coding / ACP        | Connect, create/load session, prompt, cancel, subscribe    | Persist external session mappings and content sent or received through Whim in coding sessions; keep main chat independent                           |
| Information sources | Capabilities, authenticate, search, read, poll with cursor | Store item revisions, subscriptions, deduplication keys, cursors, and collection state in the same database; manage credential references separately |
| Music               | Capabilities, devices, play/pause/seek, now playing        | Expose only implemented service operations; distinguish playback intent from account/device state                                                    |
| Dashboard widgets   | Mount, query, subscribe, dispose                           | Consume capabilities; background updates belong to plugin scope rather than page lifetime                                                            |

ACP v1 integrations use JSON-RPC over stdio as the initial transport. SSH may launch a remote adapter and forward the channel. Claude and Codex each have a separate plugin connecting their ACP adapter. Session recovery, terminal execution, and filesystem access follow the adapter's actual capabilities. An arbitrary existing tmux window is not automatically an ACP session. [ACP transport](https://agentclientprotocol.com/protocol/v1/transports), [Claude adapter](https://github.com/agentclientprotocol/claude-agent-acp), [Codex adapter](https://github.com/agentclientprotocol/codex-acp).

External agents own additional remote state. Whim's database is authoritative for its observed input/output, mappings, and execution intent, not unseen remote internals. Resending remote work follows the same unknown-outcome and reconciliation rules.

Information-source plugins declare authentication requirements, runtime dependencies, and supported collection operations. Music plugins declare available controls and playback mechanisms. Embedded playback and complete catalog access are enabled only after the corresponding integration supports them.

## 12. Shared versions and releases

All Whim-owned applications, packages, and plugins share one release version, including unchanged packages. Internal published dependencies and peers use that version. Third-party dependencies keep their own versions.

The first application bundles its plugin artifacts and loads matching versions. Runtime npm installation and its upgrade machinery are later work. When independent installation is added, publish and verify the complete package set before releasing its manifest; npm publication is not atomic.

Database migrations and record schema versions remain independent of package versions. Append migrations, preserve old-record decoding, and verify compatibility before any binary rollback. Queued plans referencing incompatible adapters are blocked or explicitly replanned as described above.

## 13. Filesystem and artifacts

Use Electron's application userData directory for `whim.sqlite`, including its WAL/SHM companions. Keep rebuildable caches and temporary exports in separate cache/temp directories. Bundled plugin code belongs to the application; later installed packages use versioned code directories. No application state is written into a user's project by default.

Distinguish managed content from external working files:

- **Managed artifacts:** imported attachments, generated documents, and file snapshots referenced by agent history have immutable content hashes, media types, sizes, and logical names. Initially store bounded artifact bytes as BLOBs in the same SQLite database, committing the blob and reference together. This keeps the database sufficient to reconstruct owned content without a disk/database dual-write protocol.
- **External workspaces:** user-selected project directories remain ordinary mutable files. The database stores the selected root and operation records; it is not a second copy of the entire repository. A historical path alone cannot reproduce old content. If a file's content enters durable context, persist the exact consumed content or a managed snapshot and reference that version.
- **Materialized files:** exports and temporary files are copies of managed artifacts. Create them with asynchronous I/O and atomic replacement where applicable. Their removal must not destroy the sole copy of an agent artifact.

Start with text and small artifacts, with an explicit configurable import-size limit validated before loading bytes. Large media and external blob storage are deferred pending a commit/reconciliation/backup design; do not silently fall back to untracked disk storage.

A Core-owned file service provides import, export, read, and supported workspace writes through the same command boundary used by UI and tools. Resolve relative paths against an explicitly selected root, reject traversal, check resolved symlink destinations, and account for filesystem race conditions. Trusted-plugin execution is not an OS filesystem sandbox.

Workspace changes are external effects: persist intent, check any expected content hash before modifying a file, and record outcome or uncertainty. A user or other application may change files concurrently. Do not infer rollback from cancellation or automatically retry an unknown destructive write. Destructive operations require explicit user intent or an applicable persisted grant.

Back up SQLite using a consistent backup mechanism. Since managed bytes are in SQLite, the database backup includes them. It does not include external workspaces, Keychain secrets, or optional remote trace storage. Restoring credentials may require reauthentication.

## 14. OpenTelemetry tracing

Agent execution and model calls support OpenTelemetry from their first implementation. Tracing is observability, not durable history, scheduling, or token accounting.

The application initializes the SDK and context manager once per instrumented process. Libraries use `@opentelemetry/api` and do not create exporters or global providers themselves. No SDK means no-op instrumentation. Configure an optional OTLP exporter; exporting is off until an endpoint is configured and is never required to use the application.

Use short-lived spans with explicit ownership:

- An agent turn/execution span contains context preparation, model attempts, tool execution, compaction, and result commit spans.
- Each actual Chat request has a model span; Decision follows the same invocation instrumentation boundary.
- A streamed model span lasts until completion, failure, cancellation, or iterator disposal, not merely until response headers arrive. Preserve async context throughout consumption and end spans exactly once.
- Include session/run/attempt identifiers, provider/model/adapter, latency, outcome, and reported token counts. Store optional trace/span IDs on execution records for correlation, never as business IDs or deduplication keys.

Propagate W3C trace context explicitly across Electron IPC and DB worker messages; async context does not cross these boundaries automatically. Validate carriers and do not forward arbitrary baggage or credentials. After a process restart, create a new span linked to the previous attempt's context rather than pretending to resume a lost live span.

Do not capture prompts, completions, thinking, task descriptions, tool arguments/results, file contents, or secrets in default trace attributes/events. Keep traces independent from the global activity index. Sampling or exporter failure must not change persistence or actual token totals. Export uses bounded queues, nonfatal failure handling, and bounded shutdown flushing; trace loss is permitted.

Use stable instrumentation names and pin any adopted GenAI semantic convention version during implementation. Verify parent-child relationships, concurrent-session isolation, stream termination, retry spans, exporter-disabled behavior, and content exclusion with an in-memory test exporter.

References: [OpenTelemetry JS instrumentation](https://opentelemetry.io/docs/languages/js/instrumentation/), [context propagation](https://opentelemetry.io/docs/languages/js/propagation/).

## 15. Implementation and acceptance

The ordered implementation and acceptance gates are maintained in [roadmap.md](roadmap.md). This document specifies the target behavior; the baseline commit contains documentation and tooling only.

The minimum completed agent path includes input acceptance, append-only state/tasks/compaction, model invocation, token accounting, tracing, result commit, and restart recovery. First prove these with real temporary SQLite, deterministic model fixtures, and actual process termination. Add live DashScope verification and the bilingual desktop shell before calling the application usable.

Fork UI, dynamic npm installation, large-file storage, ACP, information sources, and music follow their explicit roadmap stages. Do not create empty packages or claim unimplemented acceptance criteria have passed.
