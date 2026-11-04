# Whim Application Design

Whim is a macOS desktop agent workspace built with Electron, TypeScript, React, and pnpm workspaces. This document defines the application architecture: processes, packages, plugins, credentials, model cards, storage, errors, and the frontend shell. [agent.md](agent.md) defines agent execution and context. [roadmap.md](roadmap.md) is the task list. Provider facts and their verification dates live in [providers/](providers/).

Everything outside Core is a plugin. Core owns contracts, persistence, the agent runtime host, and the services plugins call; it does not know any provider protocol.

## 1. Scope

The first release ships:

- One model provider plugin, DashScope (Alibaba Cloud Model Studio), with a Chat adapter over the Responses API. A Decision adapter (TypeSafe System One) follows for automatic tool review.
- A conversation agent with streaming, Stop-and-continue, error classification and retries, compaction, prompt-cache-preserving context sources, skills, file memory, local tools, background jobs, and permissions. Delivery order is in [roadmap.md](roadmap.md).
- An application shell with Chat, Models, Plugins, and Settings pages in English and Simplified Chinese.

macOS only. Model tokens are tracked; prices and costs are not.

## 2. Principles

- **Core is protocol-agnostic.** Provider wire formats, quirks, and parameter mappings live in plugins. Shared protocol code is a library that plugins import, never a configurable compatibility layer in Core (§7.5).
- **Use existing conventions.** Configuration is described with JSON Schema 2020-12, user overrides of model cards are JSON Merge Patch (RFC 7386), identifiers follow package names. New conventions are added only where no standard exists, and are documented here.
- **Append-only facts, rebuildable views.** Agent state is an append-only journal; everything else the UI shows is a projection that can be rebuilt.
- **Fail one thing, not everything.** An invalid card, a plugin that fails to activate, or a session whose records cannot be decoded is reported on its own and does not stop the application.
- **Every boundary validates.** IPC, plugin input, card files, remote data, and database rows are `unknown` until a schema narrows them.

## 3. Packages

| Package                     | Responsibility                                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@whimkit/core`             | Contracts, SQLite store and DB worker, plugin host, credential and catalog services, attachment and file services, Job service, agent runtime host |
| `@whimkit/agent`            | The agent async generator: reasoning steps, context assembly, compaction, tool scheduling. Accesses Core only through ports.                       |
| `@whimkit/openai-protocol`  | Library: Responses wire types, SSE decoding, stream-event normalization helpers. No vendor detection, no runtime configuration.                    |
| `@whimkit/plugin-dashscope` | DashScope credential type, Chat adapter, seed cards                                                                                                |
| `apps/desktop`              | Electron Main, Backend entry, Renderer, preload, shadcn components (`src/components/ui`), feature pages                                            |

Core exposes subpaths:

- `@whimkit/core/contracts` — browser-safe schemas and types (records, cards, failures, IPC payloads). Used by Renderer, agent, and plugins.
- `@whimkit/core/plugin` — the plugin API types (`PluginContext`, registration shapes). Plugins depend only on this and `contracts`.
- `@whimkit/core` — the Node runtime, used by `apps/desktop` Backend.

Dependency rules: agent depends on `core/contracts`; Core does not import agent; desktop wires agent to Core's ports. Plugins depend on Core's public subpaths and libraries such as `openai-protocol`, never on another package's internals.

There is no shared UI package. shadcn components are installed with the official CLI into `apps/desktop`. A UI package is introduced only when plugin client entries need to share components with the host (§5.6).

## 4. Processes

| Process    | Owns                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------ |
| Main       | Windows, menus, native dialogs, single-instance lock, Backend supervision, application lifecycle |
| Renderer   | Sandboxed React UI. No Node, no SQL, no arbitrary IPC; only the typed preload API                |
| Backend    | Electron `utilityProcess`: Core services, plugin host entries, agent runners, Keychain access    |
| DB worker  | A worker thread inside Backend that owns the synchronous SQLite connection                       |
| PDF helper | On-demand child process with memory and time limits for document parsing                         |

- Main calls `app.requestSingleInstanceLock()`; a second launch focuses the existing window. Two Backends never share one database.
- Main restarts Backend after an unexpected exit with backoff, and shows a recoverable error state in the window meanwhile. Backend recovers unfinished work from the database on start.
- Renderer talks to Backend over a `MessagePort` brokered by Main. Queries, commands, and subscriptions are separate typed channels validated at both ends.
- Shutdown order: stop admission → interrupt runs with reason `shutdown` → drain or cancel jobs within a bound → deactivate plugins in reverse dependency order → close the database.
- Attachments are selected through a Main dialog; Renderer receives an opaque handle and Backend reads the file. File bytes never cross IPC as base64.

## 5. Plugins

### 5.1 Manifest

A plugin is an npm package with a `whim` field in `package.json`:

```json
{
    "name": "@whimkit/plugin-dashscope",
    "version": "0.1.0",
    "type": "module",
    "whim": {
        "host": "./dist/host.js",
        "cards": "./cards",
        "requires": []
    },
    "peerDependencies": { "@whimkit/core": "0.1.0" }
}
```

- The plugin id is the package name; the version is `package.json.version`. Whim-owned packages share one version, and `peerDependencies` pins Core exactly.
- `host` is the Backend entry. `client` (Renderer entry) is reserved for UI slots (§5.6).
- `cards` is a directory of seed model cards (§7.3).
- `requires` lists plugin ids whose registrations this plugin uses, e.g. another plugin's credential type.
- Display strings come from the plugin's `locales/en.json` and `locales/zh-CN.json`.

### 5.2 Lifecycle

```ts
export default definePlugin({
    async activate(context: PluginContext): Promise<void> {
        context.credentials.registerType(dashscopeKey);
        context.models.registerAdapter(dashscopeChat);
    },
});
```

- `activate` receives a `PluginContext` scoped to this activation. Every `register*` call returns a disposer and is owned by the scope.
- Registrations become visible only after `activate` resolves. If it throws or times out, all registrations from that attempt are disposed and the plugin is `failed` with the preserved cause.
- Deactivation stops admission of new calls to the plugin, cancels or drains in-flight calls within a bound, then disposes registrations in reverse order.
- In-flight calls are bound to the adapter instance they started with. Package upgrades take effect after restart.

Plugin state is tracked in three separate fields: installation (record exists), desired activation (user enabled/disabled), and actual availability (`active` / `failed` / `modified` / `missing-dependency`).

### 5.3 Installation and integrity

Core stores one row per installed plugin: `id`, `version`, `source` (`bundled` or `local`), `installedAt`, `contentHash`, `enabled`.

- `contentHash` is a SHA-256 over the package's files, computed at installation.
- On start Core recomputes it. A mismatch sets availability `modified` and the plugin is not activated until the user re-trusts it in the Plugins page, which records the new hash.
- Bundled plugins live inside the signed application bundle; the check matters mainly for local installs.
- Disabling or uninstalling a plugin never deletes business history, credentials, or sessions that used it. Sessions whose adapter is unavailable show that state and cannot run until it returns.

### 5.4 Registrations

| Registration    | Purpose                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------- |
| Credential type | A JSON Schema for one kind of account credential (§6)                                                               |
| Model adapter   | Implements one model kind (`chat`, later `decision`, `tts`, `asr`, `embedding`) (§7.4)                              |
| Processor       | Converts an attachment media type into model-deliverable content (§8)                                               |
| Tool            | A local tool declaration and executor ([agent.md §9](agent.md#9-tools))                                             |
| Context source  | A prefix-affecting source such as skills or memory ([agent.md §7](agent.md#7-context-sources-and-the-prompt-cache)) |
| Settings        | A JSON Schema for plugin-level settings, stored by Core                                                             |

Plugins call Core services (store commands, model slots, files, jobs). They never open the database or write SQL, and they cannot make model calls that bypass attempt and usage accounting.

### 5.5 JSON Schema conventions

Credential types, plugin settings, and card `options` are JSON Schema 2020-12 objects. Core validates values with a standard validator and renders forms from the schema.

- Secrets: `"writeOnly": true` plus `"format": "password"`. Core stores these properties in Keychain and never returns them to Renderer.
- Choices: `enum` with `default`. URLs: `"format": "uri"`. Required fields: `required`.
- `title` and `description` are the English text. Translations are looked up in the plugin's locale catalog under `schema.<schemaId>.<JSON pointer>.title|description`.
- Extension keywords use the `x-whim-` prefix and are limited to those listed here. Currently there is one: `x-whim-order`, an integer for form field ordering.

### 5.6 Client entries

A plugin may later ship a `client` entry that registers React components into named Renderer slots. It runs with the host's React and component modules and communicates only through typed application interfaces. The first release generates all plugin configuration forms from JSON Schema and ships no client entries; the slot registry is built with its first consumer.

## 6. Credentials and model slots

Credentials are separate from models. One credential serves every model kind a provider offers, and a user may keep several credentials for the same provider.

### 6.1 Credential types

A plugin registers a credential type with an id (`<pluginId>#<name>`) and a schema. DashScope:

```json
{
    "$id": "@whimkit/plugin-dashscope#api-key",
    "type": "object",
    "title": "DashScope API key",
    "required": ["apiKey", "region"],
    "properties": {
        "apiKey": { "type": "string", "title": "API key", "writeOnly": true, "format": "password" },
        "region": {
            "type": "string",
            "title": "Region",
            "enum": [
                "cn-beijing",
                "ap-southeast-1",
                "us-east-1",
                "eu-central-1",
                "cn-hongkong",
                "ap-northeast-1"
            ],
            "default": "cn-beijing"
        },
        "workspaceId": { "type": "string", "title": "Workspace ID" }
    }
}
```

Each adapter reads the fields it needs: a Chat adapter derives its HTTP endpoint from `region` and `workspaceId`; a future realtime adapter derives a WebSocket endpoint from the same credential. The credential type does not know which adapters exist. A third-party plugin can accept this credential type by listing `@whimkit/plugin-dashscope` in `requires`.

A credential type may provide `verify(credential, signal)` for the Models page "Test" action.

### 6.2 Credential instances

The user creates instances in the Models page: `id`, `typeId`, `label`, non-secret values (SQLite), secret values (Keychain item per property, keyed by credential id and property name). Renderer sees only whether a secret is set. Updating a secret is write-only.

Changing a credential is not prompt-affecting: it applies to the next attempt of every session that uses it.

### 6.3 Model slots

A slot is a role in the application that needs a model: `chat` (default for new sessions), `compaction`, `reviewer`, later `tts`, `asr`, `embedding`. A slot value is `{ credentialId, cardId, thinking? }`. The Models page lists, per slot, the credentials whose type an adapter of the slot's kind accepts, then the cards of that adapter.

A session copies the `chat` slot when it is created. Changing the model inside a session is prompt-affecting and takes effect at the next compaction ([agent.md §8](agent.md#8-compaction)); the UI offers to compact immediately.

## 7. Model cards

### 7.1 Card schema

A card describes one model for one adapter. Core understands the top-level fields; `options` belong to the adapter and are validated by the adapter's schema.

```json
{
    "id": "dashscope/qwen3.8-max",
    "revision": 1,
    "kind": "chat",
    "adapter": "@whimkit/plugin-dashscope#chat",
    "model": "qwen3.8-max",
    "name": "Qwen3.8 Max",
    "contextWindow": 1000000,
    "maxOutputTokens": 65536,
    "input": {
        "text/plain": {},
        "image/png": { "delivery": ["inline", "url"], "maxBytes": 10485760 },
        "image/jpeg": { "delivery": ["inline", "url"], "maxBytes": 10485760 },
        "application/pdf": { "delivery": ["inline"], "maxBytes": 104857600, "maxPages": 10 }
    },
    "output": ["text/plain"],
    "thinking": { "levels": ["off", "low", "medium", "high", "max"], "default": "high" },
    "nativeTools": ["web_search", "web_fetch"],
    "options": {}
}
```

Numeric values in this example are illustrative; seed card values are verified against provider documentation when the cards are written.

| Field         | Meaning                                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | Globally unique card id                                                                                                                                                         |
| `revision`    | Positive integer, raised by the card's publisher on every change                                                                                                                |
| `kind`        | Model kind; selects the adapter interface                                                                                                                                       |
| `adapter`     | Registered adapter id that serves this card                                                                                                                                     |
| `model`       | The provider's model identifier                                                                                                                                                 |
| `input`       | Allowlist keyed by media type. `delivery` lists methods the adapter implements: `inline` (bytes in the request), `url`, `file` (provider upload). Absent types are unsupported. |
| `output`      | Media types the model produces                                                                                                                                                  |
| `thinking`    | Absent: no thinking. `{ "fixed": true }`: always on, not adjustable. `{ "levels", "default" }`: user-selectable levels                                                          |
| `nativeTools` | Core tool ids the provider executes server-side (§7.6)                                                                                                                          |
| `options`     | Adapter-specific settings, validated by the adapter's JSON Schema                                                                                                               |

Thinking levels use a fixed vocabulary of at most five values: `off`, `low`, `medium`, `high`, `max`. A card lists the subset it supports. Mapping a level to provider parameters is the adapter's job; an adapter may accept a mapping override in `options` for models that deviate.

Cards contain no pricing, no provider evidence, and no protocol fields that Core would have to interpret. Provider facts and their verification dates live in [providers/](providers/).

### 7.2 Validation

A card is loaded only if it passes Core's card schema, the adapter's `options` schema, and the adapter's `validateCard` hook for cross-field rules (for example, DashScope requires `web_search` whenever `web_fetch` is enabled). A card that fails is listed in the Models page with its errors and cannot be selected. It never prevents other cards, plugins, or the application from loading.

### 7.3 Catalog layers

The effective catalog is the merge of two layers:

1. **Upstream (read-only).** Seed cards from each active plugin's `cards` directory. A later release adds an optional remote catalog per plugin, stored under `<userData>/catalog/<pluginId>/`; the bundled seeds stay as the offline fallback.
2. **User.** JSON files under `<userData>/models/`. A file whose `id` matches an upstream card is a JSON Merge Patch over it; any other file is a complete user card. A patch may set `"hidden": true` to remove an upstream card from selection.

Upstream can therefore change without overwriting user edits, and Core never needs to decide whether a copied file was modified. The Models page edits cards by writing user-layer files; users may also edit them directly. A file watcher triggers re-reads, and content hashes decide whether anything changed.

Core records catalog provenance (upstream source and plugin version, user file path, load time) in SQLite for display; card files carry no provenance.

### 7.4 Adapters

```ts
interface ChatAdapter {
    readonly id: string;
    readonly kind: 'chat';
    readonly credentialTypes: readonly string[];
    readonly optionsSchema: JsonSchema;
    validateCard?(card: ChatCard): readonly CardIssue[];
    open(binding: { card: FrozenChatCard; credential: ResolvedCredential }): ChatSession;
}

interface ChatSession {
    /** Largest input the adapter will send for this card, after provider-specific margins. */
    inputBudget(): number;
    countTokens?(request: ChatRequest, signal: AbortSignal): Promise<number>;
    stream(request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;
}
```

- `stream` yields normalized events: text and reasoning deltas, completed output items (assistant message, function call, provider-executed tool call, opaque continuation), and exactly one terminal event (`completed` with usage, or a thrown `ApplicationError`). End of stream without a terminal event is a protocol failure.
- Adapters perform no hidden retries; the runtime owns retries ([agent.md §6](agent.md#6-errors-and-retries)).
- `inputBudget` replaces hard-coded limits. DashScope silently truncates input above roughly 80% of the context window, so its adapter returns a budget below that point rather than the raw window.
- Continuation items (for example, encrypted reasoning) are opaque to Core and tagged with the adapter id and an adapter format version, so replay through a different adapter is rejected explicitly instead of sending foreign data.

### 7.5 Shared protocol code

"OpenAI-compatible" endpoints differ in thinking parameters, reasoning replay fields, usage accounting, output-limit field names, tool-schema strictness, and role handling. A single configurable compatibility adapter accumulates per-vendor flags and endpoint heuristics until every fix risks another vendor. Whim avoids this:

- `@whimkit/openai-protocol` contains only what is identical across vendors: wire types, SSE framing, event decoding, and message serialization helpers.
- Each provider plugin composes these pieces and states its differences in code. Vendor behavior is never inferred from base URLs.
- A future `plugin-openai-compatible` serves user-configured endpoints with a credential `{ baseUrl, apiKey }` and a small, explicit `options` schema. It is a plugin like any other.

### 7.6 Native and local tools

Core defines standard tool ids with Core-owned semantics, initially `web_search` and `web_fetch`. For each id, at epoch creation:

1. If the card lists it in `nativeTools` and the user has not disabled native execution, the adapter receives it as a native tool. The provider executes it during the response; Core records the provider-executed call for display and replay and never executes it again.
2. Otherwise, if a plugin registers a local implementation, the tool is an ordinary local tool subject to permissions.
3. Otherwise the tool is not offered to the model.

Provider-only tools without a Core equivalent (for example DashScope `code_interpreter`) are declared by the adapter as additional native tool ids, namespaced by plugin, and are opt-in per session.

## 8. Attachments

A media type is admissible for a session when the card's `input` declares it (native) or an active processor converts it into a type the card accepts.

- Native wins by default; Settings can prefer processing per media type.
- Limits are checked **before** the message is accepted: per-file bytes and pages from the card or processor, attachment count, and the estimated context cost against `inputBudget`. A message that cannot fit is rejected with a specific error; it never enters the inbox.
- Original bytes are stored once as immutable, content-addressed files under `<userData>/artifacts/` with metadata in SQLite. Prepared content (extracted text, page images) is snapshotted into SQLite when a reasoning step consumes it, so replay never depends on re-running a processor.
- Core's PDF processor runs in the PDF helper process with byte, page, time, and memory limits. Pages without extractable text are reported as such instead of failing the whole document. A failed attachment marks only that attachment failed.
- Renderer duplicates no limits: it asks Backend for the effective admission policy of the session and shows it.

## 9. Storage

One SQLite database at `<userData>/whim.sqlite`, opened only by the DB worker (WAL, `synchronous=FULL`, foreign keys on).

| Table         | Content                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------- |
| `journal`     | Agent records: `session_id`, `seq`, `id`, `type`, `version`, `body` (JSON)                   |
| `sessions`    | Projection: title, created/updated time, head seq, epoch id, state. Rebuildable from journal |
| `receipts`    | Command idempotency: operation id, canonical input hash, produced record ids                 |
| `plugins`     | Installation records (§5.3)                                                                  |
| `credentials` | Credential instances without secrets (§6.2)                                                  |
| `settings`    | Owner-scoped JSON values validated by the owner's schema                                     |
| `artifacts`   | Attachment and offload metadata; bytes live in files                                         |
| `sources`     | Context-source revisions ([agent.md §7](agent.md#7-context-sources-and-the-prompt-cache))    |
| `catalog`     | Card provenance (§7.3)                                                                       |

- **Records are versioned.** Each record has `type` and `version`. Decoders accept every released version and upcast to the current shape; released versions are never removed. A record that cannot be decoded marks its session `unreadable` with the cause; other sessions are unaffected.
- **Records reference, they do not embed foreign schemas.** An epoch stores a frozen copy of the card fields it uses, validated by a record-owned schema, not by the live card schema.
- **Commands are idempotent.** The same operation id and canonical input returns the original receipt; a different input conflicts. Canonical encoding sorts keys by code point, independent of locale.
- **Migrations are append-only.** Before migrating, Core writes a backup with `VACUUM INTO`. A failed migration leaves the original file untouched and reports the failure.
- **Short transactions.** No network I/O or awaits inside a transaction; each command is one DB-worker request.
- Credentials are in Keychain, never in the database or logs.

## 10. Errors

Adapters convert provider failures into Core's `Failure` at the boundary. The runtime decides retries ([agent.md §6](agent.md#6-errors-and-retries)); the frontend displays committed failures.

```ts
type Failure = {
    category:
        | 'authentication'
        | 'permission'
        | 'account'
        | 'rate-limited'
        | 'overloaded'
        | 'context-limit'
        | 'content-filtered'
        | 'invalid-request'
        | 'model-unavailable'
        | 'transport'
        | 'timeout'
        | 'protocol'
        | 'cancelled'
        | 'internal';
    retry:
        | { kind: 'never' }
        | { kind: 'after-change'; change: 'credential' | 'input' | 'configuration' | 'account' }
        | { kind: 'backoff'; afterMs?: number };
    outcome: 'rejected' | 'partial' | 'unknown';
    detail?: {
        provider: string;
        status?: number;
        code?: string;
        message?: string;
        requestId?: string;
    };
};
```

- `category` is the cause, `retry` is what could make a repeat succeed, `outcome` is what is known about remote effects (`rejected`: nothing happened; `partial`: some output arrived; `unknown`: the request may have completed).
- `detail` carries the provider's status, code, message, and request id, bounded in size. The UI shows a translated message for the category with the provider detail beneath it. `detail` never enters traces or logs that could leave the machine.
- Internal errors keep their cause chain in diagnostics. Nothing collapses distinct failures into one generic message.
- DashScope's mapping is in [providers/dashscope.md](providers/dashscope.md).

## 11. Frontend

### 11.1 Shell

A left navigation rail (shadcn `Sidebar`, collapsible to icons) with four pages:

| Page     | Content                                                                                                         |
| -------- | --------------------------------------------------------------------------------------------------------------- |
| Chat     | Session list column, conversation, composer with model and thinking selectors, attachments                      |
| Models   | Credentials (create, test, edit), model slots, catalog with card details, validation errors, and card editing   |
| Plugins  | Installed plugins: version, installed time, source, availability, errors, enable/disable, re-trust after change |
| Settings | Language, appearance, permission mode and rules, data location and backup                                       |

The rail has room for later pages; a page is added when its feature exists, not as an empty placeholder. The language selector is persistent and every string is in typed en/zh-CN catalogs.

### 11.2 Data flow

- Renderer loads a session with a query returning a bounded page of history plus the current head seq, then subscribes with `afterSeq`. Backend pushes committed records in batches after each commit; Renderer folds them into its presentation state. No full snapshots per token.
- Streaming text is persisted in bounded chunks (by size or a short interval), each chunk one transaction, and published only after commit.
- Commands return acceptance, not completion. The UI shows queued, included, running, retrying, interrupted, failed, and completed states from committed records.
- Notices ([agent.md §4](agent.md#4-messages-and-notices)) carry `kind` and `origin`; the frontend decides which kinds to display and how.

### 11.3 Components and style

Use official shadcn/ui components and AI Elements (conversation, message, prompt input, reasoning) from the official registry, installed with the CLI into `apps/desktop/src/components/ui`. Compose and theme them through tokens; do not restyle internals with broad selectors. The visual direction is minimal and flat with clear hierarchy, restrained accents, and responsive feedback. Keyboard and focus behavior are part of acceptance.

## 12. Observability

Instrument agent steps, model attempts, tool calls, compaction, and commits with the OpenTelemetry API; the application owns SDK and exporter setup and runs normally without them. Spans end on every terminal path and propagate across IPC and worker boundaries explicitly. Prompts, outputs, reasoning, file content, credentials, and provider error messages are never put in default spans.

## 13. Versions and releases

Application, Core, agent, libraries, and first-party plugins release at one shared version. Database schema versions, record versions, and card revisions are independent of it. A binary rollback does not imply the database can be downgraded.

## 14. Verification

- Store, migrations, idempotency, and projection rebuilds run against real temporary SQLite databases. Crash safety is tested by killing real processes.
- Adapters are tested with recorded protocol fixtures covering success, every mapped error, truncation, cancellation, and missing usage. Live tests are labelled with model, region, and date; a skipped credential is not a pass.
- Electron process lifecycle, native modules, and plugin loading are validated in the real Electron runtime on macOS.
