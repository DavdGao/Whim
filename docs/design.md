# Whim Application Design

Whim is a macOS desktop agent workspace built with Electron, TypeScript, React, and pnpm workspaces. This document defines the application architecture: processes, packages, plugins, credentials, model cards, storage, errors, and the frontend shell. [agent.md](agent.md) defines agent execution and context. [roadmap.md](roadmap.md) is the task list. Provider facts and their verification dates live in [providers/](providers/).

Everything outside Core and the base tools (`@whimkit/tools`, part of the harness) is a plugin. Core owns contracts, persistence, the agent runtime host, and the services plugins call; it does not know any provider protocol.

## 1. Scope

The first release ships:

- One model provider plugin, DashScope (Alibaba Cloud Model Studio), with a Chat adapter over the Responses API. One Decision provider plugin, TypeSafe, with a System One adapter for automatic tool review ([providers/typesafe.md](providers/typesafe.md)).
- A conversation agent with streaming, Stop-and-continue, error classification and retries, compaction, prompt-cache-preserving context sources, skills, file memory, local tools, background jobs, and permissions. Delivery order is in [roadmap.md](roadmap.md).
- An application shell with Chat, Coding, and Settings pages (models and plugins are Settings sections) in English and Simplified Chinese.

macOS only. Model tokens are tracked; prices and costs are not.

The external coding-agent feature uses a native terminal with local/SSH execution, tmux attachment, and independent event/log collection; it does not depend on ACP. [coding-agents.md](research/coding-agents.md) defines its capabilities, technology choices, persistence and control boundaries, and acceptance criteria. History resume is not a substitute for live attachment. Its first slice is built in: the Coding page runs coding CLIs in tmux on this Mac or SSH hosts and attaches a terminal (§11.4); collection, recording, and Whim-agent control remain planned.

## 2. Principles

- **Core is protocol-agnostic.** Provider wire formats, quirks, and parameter mappings live in plugins. Shared protocol code is a library that plugins import, never a configurable compatibility layer in Core (§7.5).
- **Use existing conventions.** Configuration is described with JSON Schema 2020-12, user overrides of model cards are JSON Merge Patch (RFC 7386), identifiers follow package names. New conventions are added only where no standard exists, and are documented here.
- **Append-only facts, rebuildable views.** Agent state is an append-only journal; everything else the UI shows is a projection that can be rebuilt.
- **Fail one thing, not everything.** An invalid card, a plugin that fails to activate, or a session whose records cannot be decoded is reported on its own and does not stop the application.
- **Every boundary validates.** IPC, plugin input, card files, remote data, and database rows are `unknown` until a schema narrows them.

## 3. Packages

| Package                                                | Responsibility                                                                                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@whimkit/core`                                        | Contracts, SQLite store and DB worker, plugin host, credential and catalog services, attachment and file services, Job service, agent runtime host |
| `@whimkit/agent`                                       | The agent async generator: reasoning steps, context assembly, compaction, tool scheduling. Accesses Core only through ports.                       |
| `@whimkit/openai-protocol`                             | Library: Responses wire types, SSE decoding, stream-event normalization helpers. No vendor detection, no runtime configuration.                    |
| `@whimkit/plugin-dashscope`                            | DashScope credential type, Chat adapter, seed cards                                                                                                |
| `@whimkit/plugin-claude-code`, `@whimkit/plugin-codex` | The Claude Code and Codex CLIs as coding agents for the Coding page (§11.4)                                                                        |
| `@whimkit/ui`                                          | shadcn and AI Elements components, the design tokens (`globals.css`); shared by the Renderer and, later, plugin client entries (§5.7)              |
| `apps/desktop`                                         | Electron Main, Backend entry, Renderer, preload, feature pages                                                                                     |

Core exposes subpaths:

- `@whimkit/core/contracts` — browser-safe schemas and types (records, cards, failures, IPC payloads). Used by Renderer, agent, and plugins.
- `@whimkit/core/plugin` — the plugin API types (`PluginContext`, registration shapes). Plugins depend only on this and `contracts`.
- `@whimkit/core` — the Node runtime, used by `apps/desktop` Backend.

Dependency rules: agent depends on `core/contracts`; Core does not import agent; desktop wires agent to Core's ports. Plugins depend on Core's public subpaths and libraries such as `openai-protocol`, never on another package's internals.

`@whimkit/ui` is a source package that Vite compiles into the Renderer. shadcn components and AI Elements are installed into it with the official CLI, run in `packages/ui` (shadcn's monorepo layout: its `components.json` aliases are `@whimkit/ui/...`). Importers use `@whimkit/ui/components/<name>`, `@whimkit/ui/lib/utils`, and `@whimkit/ui/hooks/<name>`. Plugin client entries will share the same modules through the import map (§5.7).

## 4. Processes

| Process    | Owns                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------ |
| Main       | Windows, menus, native dialogs, single-instance lock, Backend supervision, application lifecycle |
| Renderer   | Sandboxed React UI. No Node, no SQL, no arbitrary IPC; only the typed preload API                |
| Backend    | Electron `utilityProcess`: Core services, plugin host entries, agent runners                     |
| DB worker  | A worker thread inside Backend that owns the synchronous SQLite connection                       |
| PDF helper | On-demand child process with memory and time limits for document parsing                         |

- Main calls `app.requestSingleInstanceLock()`; a second launch focuses the existing window. Two Backends never share one database.
- Main restarts Backend after an unexpected exit with backoff, and shows a recoverable error state in the window meanwhile. Backend recovers unfinished work from the database on start.
- Renderer talks to Backend over a `MessagePort` brokered by Main. Queries, commands, and subscriptions are separate typed channels validated at both ends.
- Shutdown order: stop admission → interrupt runs with reason `shutdown` → drain or cancel jobs within a bound → deactivate plugins in reverse dependency order → close the database.
- Attachments come from the composer's file chooser, drag and drop, or paste. Renderer hands each file's bytes to Backend once (`attachment.stage`, as a binary `Uint8Array`, never Base64); Backend decides the type and keeps the file under a content hash until the message is sent. Renderer never names a path for Backend to read.

### 4.1 Background operation

Whim keeps working when its window is closed. The window is a view; work belongs to Backend.

- **Window closed ≠ quit.** Closing the window leaves Main and Backend running. Runs, tool jobs, and plugin services continue. Reopening the window (Dock, menu bar item, notification, or a second launch) reconnects Renderer, which catches up by sequence number.
- **Menu bar item.** While Whim runs, Main shows a menu bar item (Electron `Tray`, a template image so it follows the menu bar's appearance). Its title shows how many chats are running, and its menu lists the chats that are running or waiting for the user (clicking one opens the window at that chat), then Open Whim and Quit Whim.
- **Activity.** Backend sends Main an activity snapshot whenever a run starts or ends or an ask changes: the running chats with their titles and whether each waits for the user, and the UI locale. Main keeps no state of its own beyond the latest snapshot; the snapshot is derived from committed records, so a Backend restart simply sends a new one.
- **Attention.** Backend sends Main an attention event when a committed record needs the user: a run ended (completed or failed) or a permission ask waits for the user. Main shows it as a macOS notification only when no Whim window is focused; clicking it opens the window at the chat. Interrupted runs (Stop, shutdown) do not notify.
- **Quit.** Quit Whim in the menu bar item, ⌘Q, or logout stops Backend; closing windows never does. When chats are running, Quit first asks in a native dialog naming how many will be interrupted; confirmed, it follows the shutdown order above. Logout and system shutdown do not ask.
- **Power.** While any chat is running, Main holds `powerSaveBlocker('prevent-app-suspension')`, so App Nap does not throttle a windowless app; it releases the blocker when the snapshot shows nothing running. Whim does not keep the display awake.
- **Unattended asks.** A run with no one watching asks normally: the ask waits (with a notification), or goes to the automatic reviewer when auto mode is on (agent.md §10.1). Nothing is approved because the window is closed.
- **Main strings.** The menu bar item, notifications, and the quit dialog use Main's own small en/zh-CN catalog, keyed by the locale in the activity snapshot.
- **Beyond Whim's lifetime.** Work that must survive Quit, logout, or a crash runs outside Whim, such as tmux on the execution host for coding agents ([research/coding-agents.md](research/coding-agents.md)). Whim installs no separate always-on daemon: Main stays the long-lived process because it alone owns `safeStorage`, windows, and notifications.
- **Planned.** Launch at login (`app.setLoginItemSettings`; started at login, Main opens no window), a setting that hides the Dock icon while no window is open, and schedules and triggers (§4.1.1).

#### 4.1.1 Schedules and triggers

Background work that starts without the user is a **trigger** delivering input into a session's inbox, so it follows the same run, permission, and recovery rules as typed input. Schedules are the first kind; plugin event sources come later.

- **Records.** Core owns schedule rows in SQLite (`schedules`): the session it delivers to, a name, the message, its timing (a single fire `at` a time, or five `cron` fields read in an IANA time zone, the user's by default), the missed-fire policy (`skip` or `once`), whether it is paused, and its next and last fire. A row is deleted with its session and after its single fire. A conversation has at most 20 schedules, and a cron schedule fires at most every 5 minutes, so a schedule cannot spend tokens in a tight loop.
- **Timer.** Backend's `Scheduler` is the only writer of schedule rows. It keeps one timer for the earliest next fire, read from the rows and never from memory alone, and reads them again at least hourly so a clock change is seen. It starts after recovery and stops before the database closes.
- **Fire.** A fire commits, in one transaction, the delivery (a `schedule-fired` notice with the schedule id, name, due time, and whether it is late, carrying the message as its text) and the schedule's next fire, which is the first one after now. The commit applies only while the row still has the fire time read, so a restart or a concurrent change never fires twice. The session is then woken with trigger `schedule`. A fire more than a minute after its time was missed (Whim not running, the Mac asleep): `once` delivers it once, marked late, however many were missed; `skip` only moves to the next fire. A fire into a running session joins it at the next step; one that arrives as a run ends starts the next run, as a message does.
- **Tools.** The main agent manages schedules with `ScheduleCreate`, `ScheduleList`, `ScheduleUpdate`, and `ScheduleDelete`. They change only the calling conversation's schedules; `ScheduleList` with `scope: all` shows every schedule, read-only for other conversations. They touch nothing outside Whim, so they run without a confirmation; every call shows in the chat. Errors in the input (a past time, a time without an offset, a cron expression that is malformed, too frequent, or in an unknown time zone) are returned to the model with the reason.
- **Model input.** The notice renders as `<system-notification kind="schedule" schedule="…" name="…" due="…" time="…" late="true">message</system-notification>` ([agent.md §14.2](agent.md#142-marking-what-the-system-writes)); the chat shows a line naming the schedule.
- **Planned.** A Settings page listing every schedule with pause and delete, information-source agents (which do not get the schedule tools), and plugin event sources.

### 4.2 Information sources

Whim gathers information from sources such as arXiv, GitHub Trending, Zhihu, Reddit, X, Xiaohongshu, and user-supplied feeds and pages ([research/feed-sources.md](research/feed-sources.md), [feed-source-access.md](feed-source-access.md)). One agent cannot search them all in reasonable time, so each source has an agent of its own:

- **Source agents.** A source is a long-lived agent with one session, its own workspace and memory, and its own model. It knows its platform: how to search it, how to judge its content, and what it reported before. It is created from a source template a plugin contributes (§5.5): instructions, the tools it needs, and a health check. Deleting a source deletes its session and files.
- **Messages.** The main agent sends a source a request; a running source receives it at its next step and an idle one is woken. The source answers with a short summary and files, which are copied into the requester's session, so the requester reads them with Read and they outlive the source ([agent.md §15](agent.md#15-source-agents-and-messages)). Each reply wakes the requester, which decides whether to answer the user now or wait for more.
- **Increments.** What changed since last time comes from files, not from conversation memory: a source keeps its reports in its workspace and reads the previous one before writing the next, so compaction or a restart does not lose it.
- **Accounts.** Sign-in happens once, when the source is set up, and its state persists in the connector (an API credential, a browser profile, or an MCP server's own storage). A source whose health check fails is not run; the requester is told at once and the user gets a notification with a reconnect action. Agents never sign in.
- **Schedules.** Regular updates are schedules of the main agent (§4.1.1); source agents have no schedule tools.

## 5. Plugins

### 5.1 Manifest

A plugin is an npm package with a `whim` field in `package.json`:

```json
{
    "name": "@whimkit/plugin-dashscope",
    "version": "0.1.0",
    "type": "module",
    "whim": {
        "api": "1.0",
        "host": "./dist/host.js",
        "contributes": {
            "credentialTypes": ["api-key"],
            "adapters": ["responses"]
        },
        "cards": "./cards",
        "locales": "./locales",
        "category": "models",
        "icon": "./icons/bailian.svg",
        "icons": { "qwen": "./icons/qwen.svg" },
        "requires": []
    },
    "peerDependencies": { "@whimkit/core": "0.1.0" }
}
```

- The plugin id is the package name; the version is `package.json.version`. Whim-owned packages share one version, and `peerDependencies` pins Core exactly.
- `api` is the plugin API version the plugin was built against, `MAJOR.MINOR` (§5.7). Whim activates the plugin only when the majors are equal and its own minor is at least the plugin's; otherwise the plugin is `failed` with a message naming both versions.
- `host` is the Backend entry. `client` is the Renderer entry, one ES module; `clientStyle` is its precompiled CSS, beside it. `themes` lists theme files (§5.7).
- `contributes` declares, per registration kind (§5.5), the names the plugin registers: the part after `<pluginId>#` for credential types and adapters, the model-facing name for tools. The Plugins page shows the declaration, so the user sees what a plugin adds before enabling it. Registering an undeclared name fails activation; a declared name the plugin does not register (for example, behind a setting) is allowed.
- `cards` is a directory of seed model cards (§7.3).
- `category` (`models`, `tools`, or `other`, the default) groups the plugin in Settings.
- `requires` lists plugin ids whose registrations this plugin uses, e.g. another plugin's credential type.
- Display strings come from the plugin's `locales/en.json` and `locales/zh-CN.json`.
- `icon` is the plugin's logo; `icons` names further images that its cards reference by key (§7.1). Paths stay inside the package, files are SVG or PNG of at most 64 KiB, and Backend sends them to Renderer as `data:` URLs rendered with `<img>`, so SVG scripts never run. A missing or invalid icon is reported and ignored. Remote icon URLs are not fetched; they arrive with remote catalogs.

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
- Local plugins are package directories under `<userData>/plugins/`. One seen for the first time is recorded disabled; the user enables it in the Plugins page after seeing what it declares (§5.1), and it activates at the next start.

### 5.4 Disabling and removing a plugin

Disable keeps the package and its data; uninstall also removes the package (local plugins only; bundled plugins can only be disabled). Both follow the same sequence:

1. **Impact preview.** The Plugins page lists what depends on the plugin: dependent plugins, model slots bound to its cards, credentials of its types, sessions whose epoch uses its adapter, active runs, background jobs from its tools. The user confirms.
2. **Stop admission.** New calls to the plugin's adapters, tools, and processors fail with `model-unavailable` or a tool-unavailable result.
3. **Settle in-flight work.** Active runs using its adapter are interrupted with reason `plugin-removed` and receive an `interrupted` notice naming the cause; its background jobs are cancelled. Waiting is bounded.
4. **Deactivate dependents first, then the plugin**, disposing registrations in reverse order. Dependent plugins become `missing-dependency`.
5. **Propagate.** Removed tools and context sources deliver `source-changed` notices to sessions; removed tools are revoked immediately.
6. **Remove the package** (uninstall only). The install row stays, marked uninstalled, so history can name the plugin.

What is kept: sessions and their history (readable; they show "model unavailable" and can continue after a model switch), credentials (marked orphaned; the confirm dialog offers to delete them and their encrypted secrets), user-layer card files (inactive until the plugin returns). Slots bound to its cards become unset and the Models page asks for a replacement; Whim never silently substitutes another model. Reinstalling restores everything that was kept.

Startup applies the same rules when a plugin is missing or fails to activate.

### 5.5 Registrations

| Registration    | `contributes` key   | Stability    | Purpose                                                                                                             |
| --------------- | ------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------- |
| Credential type | `credentialTypes`   | stable       | A JSON Schema for one kind of account credential (§6)                                                               |
| Model adapter   | `adapters`          | stable       | Implements one model kind (`chat`, `decision`, later `tts`, `asr`, `embedding`) (§7.4)                              |
| Tool            | `tools`             | stable       | A local tool definition and executor ([agent.md §9](agent.md#9-tools)); names are unique across plugins             |
| Coding agent    | `codingAgents`      | experimental | A coding CLI's command, started in a tmux session by the Coding page (§11.4)                                        |
| Service         | `services`          | experimental | Long-running work owned by the plugin scope, independent of windows (§5.7)                                          |
| Method, topic   | `methods`, `topics` | experimental | Typed calls and subscriptions the plugin's own client entry uses (§5.7)                                             |
| Processor       | `processors`        | planned      | Converts an attachment media type into model-deliverable content (§8)                                               |
| Context source  | `contextSources`    | planned      | A prefix-affecting source such as skills or memory ([agent.md §7](agent.md#7-context-sources-and-the-prompt-cache)) |
| Settings        | —                   | planned      | A JSON Schema for plugin-level settings, stored by Core                                                             |

**Stable** registrations keep their contract within a plugin API major version; **experimental** ones may change in a minor version and say so in their types; **planned** ones are designed but not yet registrable.

Plugins call Core services (store commands, model slots, files, jobs). They never open the database or write SQL, and they cannot make model calls that bypass attempt and usage accounting.

### 5.6 JSON Schema conventions

Credential types, plugin settings, and card `options` are JSON Schema 2020-12 objects. Core validates values with a standard validator and renders forms from the schema.

- Secrets: `"writeOnly": true` plus `"format": "password"`. Core stores these properties encrypted (§6.2) and never returns them to Renderer.
- Plugin schemas carry no `$id`; the registration id (`<pluginId>#<name>`) names them, and `#` is not valid in a schema `$id`.
- Choices: `enum` with `default`. URLs: `"format": "uri"`. Required fields: `required`.
- `title` and `description` are the English text. Translations are looked up in the plugin's locale catalog under `schema.<schemaId>.<JSON pointer>.title|description`.
- Extension keywords use the `x-whim-` prefix and are limited to those listed here. Currently there is one: `x-whim-order`, an integer for form field ordering.

### 5.7 Plugin API and UI extensions

Whim's plugin system is a fixed set of typed extension points, not a general composition framework: plugins add capabilities around Core, and never replace Core's invariants (the journal, the single runner per session, the frozen prompt prefix, permissions and their review, usage accounting). Every extension point is introduced with its first consumer and listed in §5.5 or below with its stability.

**API versions.** The plugin API (the `PluginContext` and client context types, the manifest, the slot contracts) carries one version, `MAJOR.MINOR`, exported by Core as `pluginApiVersion`. Adding an extension point or an optional field raises the minor; changing or removing a stable one raises the major. Experimental extension points may change in a minor version.

**Two halves.** A plugin has up to two entries with separate lifetimes:

| Entry  | Runs in                        | Lives while                | May contribute                                                           |
| ------ | ------------------------------ | -------------------------- | ------------------------------------------------------------------------ |
| Host   | Backend (Node, full authority) | Whim runs and it is active | §5.5 registrations, services, methods and topics                         |
| Client | Renderer (sandboxed page)      | a window is open           | Pages, settings sections, tool renderers, composer actions (slots below) |

Anything that must continue without a window (a connection, a watcher, a sync loop, a terminal) is a host **service**: registered with `start(signal)`, owned by the plugin scope, and stopped in reverse order on deactivation. Client code only views and commands; unmounting never stops work. A plugin therefore works without a window, and its UI is optional (§4.1).

**Talking to the host half.** A host entry registers **methods** (request → response; Core validates the input before the handler and the output after it) and **topics** (a value with an initial state; each `publish` is validated and numbered). The client entry reaches only its own plugin's methods and topics, through `context.rpc.call` and the `context.rpc.useTopic` hook, over the existing Renderer–Backend port (`plugin.call`, `plugin.topics`, and `plugin.topic` events). A call's signal aborts when the plugin stops or the window is replaced; a reconnected window reads every topic's latest value again. Business state still changes through Core commands; plugin methods serve the plugin's own services. Services, methods, and topics are declared in `contributes` like every other registration.

**Slots.** UI extension points are named, typed slots declared by the host component that renders the location. A slot receives typed props and returns React content inside the host's layout; plugins never reach host DOM or global styles. Each slot is either additive (a list ordered by the host) or keyed (one entry per key, such as a tool name), and two plugins claiming the same key is an activation error. Every slot is wrapped in an error boundary that shows a failure naming the plugin. The host's own pages and settings tabs are registered through the same registries, so a slot is never a special path for plugins.

| Slot               | Kind               | Contract                                                                       | Status       |
| ------------------ | ------------------ | ------------------------------------------------------------------------------ | ------------ |
| `page`             | list               | A navigation rail page: id, title key, icon, component                         | experimental |
| `settings.section` | keyed by plugin    | A section on the plugin's card in Settings → Plugins                           | experimental |
| `chat.tool`        | keyed by tool name | The trace renderer of one tool's calls; the permission prompt stays the host's | experimental |
| `composer.action`  | list               | An entry in the composer's Add menu that inserts text or attaches files        | experimental |

**Themes** are data, not code. The manifest's `themes` lists JSON files; each has an `id` (unique in the plugin), a `name` (a key in the plugin's catalogs), a `light` token set, an optional `dark` set, and an optional `backgroundImage` inside the package (PNG, JPEG, or WebP, at most 2 MiB). A token set may only name the documented tokens (`themeTokens` in Core: the shadcn color tokens, the sidebar tokens, and `radius`); a value is a plain CSS value of at most 200 characters that cannot break out of the declaration or load resources (no `;`, braces, angle brackets, backslashes, `url(`, `@import`). An invalid theme is reported and skipped. Themes of active plugins appear in Settings → General → Theme; the chosen theme's tokens are set on the document root, and its image, served at `whim-plugin://themes/<pluginId>/<themeId>`, fills the window behind the chrome. Whim has a light appearance only today, so the `light` set applies; `dark` waits for a dark appearance.

**Client entries.** A client entry is one ES module whose default export is `defineClient({ activate })` from `@whimkit/client`, the client API package (context and slot types; plugins bundle it). `activate(context)` receives the plugin id, `useT` for the plugin's own locale catalogs, `rpc`, and `slots`; every slot registration must be declared in `contributes` (`pages`, `settingsSections`, `chatTools`, `composerActions`) and becomes visible only once `activate` resolves. A client entry that fails to load or activate leaves no registrations and is reported on its Plugins card; a component that throws is contained by its slot's error boundary.

**Shared runtime.** Client entries import `react`, `react/jsx-runtime`, `react-dom`, `sonner`, and `@whimkit/ui/components/*` and `@whimkit/ui/lib/utils` as externals and bundle everything else (icons included). The Renderer publishes its own module objects, and the build (`scripts/shared-modules.mjs`) emits a forwarding module per specifier and a static import map, whose hash is the only inline script the page's CSP allows; every plugin therefore uses the host's single React and component instances.

**Loading.** Main serves plugin client files through a `whim-plugin://<pluginId>/` protocol confined to the package's declared client directory; the Renderer's content security policy allows scripts only from the application and that protocol. Client entries load after Backend reports active plugins, and a plugin's slots are removed when it stops. Client styles are precompiled Tailwind against the host tokens, scoped to the plugin's root, without preflight.

**Out of scope.** Plugins cannot replace or wrap Core services, rewrite records or prompts, decide permissions (they may contribute a reviewer only through Core's reviewer contract), patch host components outside slots, or extend Main (menu bar, windows, application menu). Requests for notifications or native dialogs go through future host APIs.

**Trust.** Host entries are trusted code in Backend's failure domain (§5). Client entries are trusted to render but cannot exceed Renderer's sandbox. Installation is the trust decision; neither half is a permission boundary.

## 6. Credentials and model slots

Credentials are separate from models. One credential serves every model kind a provider offers, and a user may keep several credentials for the same provider.

### 6.1 Credential types

A plugin registers a credential type with an id (`<pluginId>#<name>`) and a schema. DashScope:

```json
{
    "type": "object",
    "title": "DashScope API key",
    "required": ["apiKey"],
    "properties": {
        "apiKey": { "type": "string", "title": "API key", "writeOnly": true, "format": "password" },
        "baseUrl": {
            "type": "string",
            "format": "uri",
            "title": "Base URL",
            "description": "Full compatible-mode base URL. Leave empty to use the default endpoint."
        }
    }
}
```

Each adapter reads the fields it needs: the Chat adapter appends its path to `baseUrl`; a future realtime adapter may add its own optional field (for example a WebSocket URL) to the same credential type. The credential type does not know which adapters exist. A third-party plugin can accept this credential type by listing `@whimkit/plugin-dashscope` in `requires`.

A credential type may provide `verify(credential, signal)` for the Models page "Test" action.

### 6.2 Credential instances

The user creates instances in the Models page: `id`, `typeId`, `label`, non-secret values (SQLite), and secret values encrypted with Electron `safeStorage`, whose key macOS keeps in the Keychain. Encryption runs in Main, the only process where `safeStorage` exists; Backend asks Main over its parent port and stores ciphertext in the `secrets` table. Without an OS key store, saving a secret fails instead of falling back to plain text; automated tests opt into Electron's plaintext fallback with `WHIM_TEST_PLAINTEXT_SECRETS=1`. Renderer sees only whether a secret is set. Updating a secret is write-only.

Changing a credential is not prompt-affecting: it applies to the next attempt of every session that uses it.

### 6.3 Model slots

A slot is a role in the application that needs a model: `chat` (default for new sessions), `compaction`, `reviewer` (automatic permission review, a Chat or Decision card), later `tts`, `asr`, `embedding`. A slot value is `{ credentialId, cardId, thinking? }`. The Models page lists, per slot, the credentials whose type an adapter of the slot's kind accepts, then the cards of that adapter.

A session copies the `chat` slot when it is created. The user can switch the session's model whenever no run is active; it applies from the next reasoning step ([agent.md §8.1](agent.md#81-model-switch)).

## 7. Model cards

### 7.1 Card schema

A card describes one model for one adapter. Core understands the top-level fields; `options` belong to the adapter and are validated by the adapter's schema.

```json
{
    "id": "dashscope/qwen3.8-max",
    "revision": 1,
    "kind": "chat",
    "adapter": "@whimkit/plugin-dashscope#responses",
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
| `icon`        | Optional key into the `icons` of the adapter's plugin (§5.1). Without it the UI shows the plugin's `icon`                                                                       |

Thinking levels use a fixed vocabulary of at most five values: `off`, `low`, `medium`, `high`, `max`. A card lists the subset it supports. Mapping a level to provider parameters is the adapter's job; an adapter may accept a mapping override in `options` for models that deviate.

A **Decision** card (`"kind": "decision"`) describes a model that returns typed, calibrated answers instead of text. It has `id`, `revision`, `kind`, `adapter`, `model`, `name`, optional `icon`, and `options`; the Chat fields (`contextWindow`, `input`, `output`, `thinking`, `nativeTools`) do not apply. Decision cards are not offered as chat models; they serve slots of their kind, such as the reviewer ([agent.md §10.1](agent.md#101-automatic-review)).

Cards contain no pricing, no provider evidence, and no protocol fields that Core would have to interpret. Provider facts and their verification dates live in [providers/](providers/).

### 7.2 Validation

A card is loaded only if it passes Core's card schema, the adapter's `options` schema, and the adapter's `validateCard` hook for cross-field rules (for example, DashScope requires `web_search` whenever `web_fetch` is enabled). A card that fails is listed in the Models page with its errors and cannot be selected. It never prevents other cards, plugins, or the application from loading.

### 7.3 Catalog layers

The effective catalog is the merge of two layers:

1. **Upstream (read-only).** Seed cards from each active plugin's `cards` directory. A later release adds an optional remote catalog per plugin, stored under `<userData>/catalog/<pluginId>/`; the bundled seeds stay as the offline fallback.
2. **User.** JSON files under `<userData>/models/`. A file whose `id` matches an upstream card is a JSON Merge Patch over it; any other file is a complete user card. A patch may set `"hidden": true` to remove an upstream card from selection.

Upstream can therefore change without overwriting user edits, and Core never needs to decide whether a copied file was modified. The Models page edits cards by writing user-layer files; users may also edit them directly. A file watcher triggers re-reads, and content hashes decide whether anything changed.

Core reports each entry's provenance (layer, plugin, source files) and validation issues on the Models page. Provenance is recomputed on every load and not stored; card files carry no provenance.

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
    /** Run one of the adapter's `separateTools` as its own provider call (§7.6). */
    runTool?(
        tool: string,
        input: object,
        options: { thinking?: ThinkingLevel; signal: AbortSignal }
    ): Promise<{ output: ToolOutput; usage: Usage }>;
}
```

A Decision adapter has the same `id`, `credentialTypes`, `optionsSchema`, and `open`, with `kind: 'decision'`, and opens a session with one call:

```ts
interface DecisionSession {
    /** One provider call; throws ApplicationError on failure and never retries. */
    decide(request: DecisionRequest, signal: AbortSignal): Promise<DecisionResult>;
}
interface DecisionRequest {
    state: string; // what every question refers to
    questions: Record<
        string,
        { type: 'choice'; instructions: string; options: Record<string, string> }
    >;
}
interface DecisionResult {
    answers: Record<
        string,
        {
            type: 'choice';
            choice: string;
            confidence: number;
            probabilities: Record<string, number>;
        }
    >;
    usage: Usage;
}
```

Only the question types a caller uses are in the contract; the reviewer uses one choice question. An adapter rejects an answer that does not match its question instead of passing it on.

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

Core defines standard tool ids with Core-owned semantics, initially `web_search` and `web_fetch`. A card's `nativeTools` lists the standard ids its provider can serve for that model; the adapter decides how each is executed. For each id, at epoch creation:

1. If the card lists it and the adapter executes it **inside the chat call**, the adapter receives it as a native tool. The provider executes it during the response; Core records the provider-executed call for display and replay and never executes it again.
2. If the card lists it and the adapter declares it in `separateTools`, the model sees the local tool with that standard id (same name, schema, and permissions), but Core runs each call through `ChatSession.runTool` with the session's card and credential: a provider call of its own, with a context independent of the chat. The epoch records these ids in `providerTools`. Its reported tokens are committed as `tool.usage` and count toward the session's usage, not its context.
3. Otherwise, if a plugin or the base tools provide a local implementation, the tool is an ordinary local tool subject to permissions.
4. Otherwise the tool is not offered to the model.

Local tools may declare a `credentialType` (for example the Tavily plugin's API key): they are declared only while the user has a credential of that type, and each call receives the most recent one in its context. Tavily's `WebSearch` implements `web_search` this way, so it reaches only models whose provider does not search natively.

The choice depends only on the card and the adapter, never on per-request options such as the thinking level, so it stays fixed for the epoch. DashScope, for example, runs `web_fetch` separately because its web extractor requires thinking: the separate call always thinks, whatever the chat's level.

Provider-only tools without a Core equivalent (for example DashScope `code_interpreter`) are declared by the adapter as additional native tool ids, namespaced by plugin, and are opt-in per session.

### 7.7 MCP servers

Core connects MCP servers centrally, as it runs tools and schedules: one connection per configured server, shared by every agent and session. A server's sign-in state belongs to its account, so two connections would sign each other out or ask twice.

- **Configuration.** Settings → MCP servers stores each server in the setting `mcp.servers`: an id (lowercase letters, digits, `-`, at most 20 characters, used in tool names), a name, whether it is enabled, whether its tools run without asking, and its transport: a local command (stdio: command, arguments, environment) or a remote URL (streamable HTTP: URL, headers). Secret environment variables and headers are entered separately, stored as `safeStorage` ciphertext, shown by name only, and decrypted only to start the server. An unreadable entry is skipped.
- **Lifecycle.** Backend's `McpServers` owns the configuration and Core's `McpHost` the connections. Enabled servers connect at start, before recovery; a saved change reconnects that server; disabling or removing it closes it; shutdown closes all after tool calls stop. A server that fails to start or closes its connection is reported with the reason and retried after 1 s, doubling to at most 5 minutes. A stdio server inherits only the SDK's safe default environment plus its configured variables.
- **Tools.** A ready server's tools are offered as `mcp__<server>__<tool>`; a name that would be invalid or longer than 64 characters is skipped and counted. The description is the server's, cut at 4,000 characters, and names the server. Like every tool set, MCP tools are frozen into an epoch: a server that connects later, or whose tool list changes, reaches a session at its next compaction or model switch. Core does not validate arguments against the server's schema (servers write draft-07 and other dialects that Whim's strict 2020-12 validator refuses); it passes a JSON object and the server validates it.
- **Calls.** Each server runs at most 4 calls at once; more wait. A call has a 10-minute limit and is aborted by Stop. Text, images, audio, embedded resources, and resource links become the tool result; structured content is used as JSON when there is no text. A call while the server is not connected returns an error result.
- **Permissions.** Calls to a server the user has not trusted ask first, with an access `{ kind: 'mcp', server, tool }`; "Allow for this session" grants that one tool. A trusted server's calls run without asking. `readOnlyHint` only marks a tool safe to run in parallel.
- **Core services.** Core can call a server's tool directly (`McpHost.call`), for checks such as a source's sign-in state (§4.2).

## 8. Attachments

A media type is admissible for a session when the card's `input` declares it (native) or an active processor converts it into a type the card accepts.

- Native wins by default; Settings can prefer processing per media type.
- Limits are checked **before** the message is accepted: per-file bytes and pages from the card or processor, attachment count, and the estimated context cost against `inputBudget`. A message that cannot fit is rejected with a specific error; it never enters the inbox.
- Every file Whim keeps for a session lives under `<userData>/sessions/<sessionId>/`: `workspace/` (the agent's working folder while the user has chosen none), `media/` (attachments and tool media, content-addressed by SHA-256), `offload/` (truncated tool output), and `jobs/` (background job logs). Deleting a session deletes its folder; files are never shared between sessions. Metadata lives in the session's records. Whim refers to its own files with standard `file:` URIs (`pathToFileURL`, percent-encoded), never bare paths, so a reference can later be opened as a link.
- Original bytes are immutable once written. Prepared content (extracted text, page images) is snapshotted into SQLite when a reasoning step consumes it, so replay never depends on re-running a processor.
- Core's PDF processor runs in the PDF helper process with byte, page, time, and memory limits. Pages without extractable text are reported as such instead of failing the whole document. A failed attachment marks only that attachment failed.
- The type comes from the content, never the name: PNG, JPEG, WebP, and GIF by signature; text when the bytes decode as UTF-8 without NUL (at most 512 KB). Anything else is refused at staging; PDF waits for its processor. At send, Backend checks each image against the session's card (`input` type and `maxBytes`) and copies it into the session's `media/` folder; Renderer marks images the current model cannot read, but Backend decides.
- A media block records the identifier the model sees (`img-<hash prefix>`), type, name, `file:` URI, size, and hash; a text file's decoded content is stored in the block, so replay never re-reads it.
- Requests render media by three rules, depending only on history, the card, and the adapter: a type the card cannot read becomes `<data id uri media_type name/>`; a user message carries readable media inline; a tool result carries readable media inline only when the adapter lists the type in `toolResultMedia`, and otherwise names the identifier while the media follow in one user message after all results of that assistant message, because providers require results to follow their calls directly. A model switch re-renders by the new card's rules.
- `Read` returns PNG, JPEG, WebP, and GIF files up to 10 MiB as images; tool media are stored like attachments.

## 9. Storage

One SQLite database at `<userData>/whim.sqlite`, opened only by the DB worker (WAL, `synchronous=FULL`, foreign keys on).

| Table         | Content                                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------------- |
| `journal`     | Agent records: `session_id`, `seq`, `id`, `type`, `version`, `body` (JSON)                                            |
| `sessions`    | Projection: title, created/updated time, head seq, epoch id, state. Rebuildable from journal                          |
| `receipts`    | Command idempotency: operation id, canonical input hash, produced record ids                                          |
| `plugins`     | Installation records (§5.3)                                                                                           |
| `credentials` | Credential instances without secrets (§6.2)                                                                           |
| `settings`    | Owner-scoped JSON values validated by the owner's schema                                                              |
| `artifacts`   | Attachment and offload metadata; bytes live in files                                                                  |
| `sources`     | Context-source revisions ([agent.md §7](agent.md#7-context-sources-and-the-prompt-cache)); added with context sources |

- **Records are versioned.** Each record has `type` and `version`. Decoders accept every released version and upcast to the current shape; released versions are never removed. A record that cannot be decoded marks its session `unreadable` with the cause; other sessions are unaffected.
- **Records reference, they do not embed foreign schemas.** An epoch stores a frozen copy of the card fields it uses, validated by a record-owned schema, not by the live card schema.
- **Commands are idempotent.** The same operation id and canonical input returns the original receipt; a different input conflicts. Canonical encoding sorts keys by code point, independent of locale.
- **Ownership is marked.** Whim sets `PRAGMA application_id` to `0x5748494d` ("WHIM"). A file at the database path that is not marked (and is not an empty or pre-marker schema 1 Whim database) is never modified: Core renames it to `whim.sqlite.foreign-<time>` with its WAL files, creates a new database, and the UI reports where the old file was kept. A marked database with a newer schema still refuses to open.
- **Migrations are append-only.** Before migrating, Core writes a backup with `VACUUM INTO`. A failed migration leaves the original file untouched and reports the failure.
- **Short transactions.** No network I/O or awaits inside a transaction; each command is one DB-worker request.
- Secrets are stored only as `safeStorage` ciphertext, never in plain text or logs.

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
        | 'output-limit'
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

The window has no native title bar (`titleBarStyle: 'hiddenInset'`). A draggable top strip in the sidebar color holds the macOS traffic lights, the rail toggle, and, when Backend is not connected, the connection status. Below it, a navigation rail (shadcn `Sidebar`, `inset` variant) sits on the same background. It is collapsed to icons by default so it never competes with a page's own list column: the Whim logo at the top, feature pages in the middle, Settings at the bottom. The active page is an inset panel.

| Page     | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat     | Session list (Pinned / Today / Earlier, rename, pin, delete), conversation with reasoning and tool calls as Trace lines (the latest 60 history entries first; pulling past the top loads earlier pages with a springy pull, no button), a one-line composer that grows and stacks its add/send buttons below the text when it wraps; the add menu attaches files or chooses the chat's folder. A chosen folder (not the default) appears in a bar above the field with its git branch and uncommitted line counts; under the field sit one model-and-thinking button and a context ring that fills toward compaction |
| Coding   | A computer picker (this Mac and saved SSH hosts), the computer's tmux sessions, and the open session's terminal (§11.4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Settings | A section list: General (language, what agents call the user, permissions: ask each time or review automatically with a chosen model, data); Agent (name, icon, system prompt); Models (credentials, default models, available models with a detail page per model, grouped by model kind as kinds are added); Plugins (grouped by manifest category)                                                                                                                                                                                                                                                                |

Pages and Settings sections are entries in registries (`PageEntry`, `SettingsSectionEntry` in `lib/navigation.ts`) that plugin pages will join (§5.7). A page receives the application state, its navigation parameters, and `navigate(page, params)`; the menu bar item opens a chat with `navigate('chat', { sessionId })`, and the Models shortcut opens `navigate('settings', { section: 'models' })`.

Configuration lives in Settings; the rail is for feature pages. Planned feature pages include Music; each is added when its feature exists. The language selector is persistent and every string is in typed en/zh-CN catalogs.

### 11.2 Data flow

Chat retains the AI Elements Conversation's bottom-following behavior. Its scroll viewport uses shadcn's `scroll-fade-y` utility: both edges fade when more content exists in that direction, and short transcripts have no fade. Running sessions display the existing Spinner with a localized accessible label instead of a pulsing dot, respecting reduced motion. Acceptance covers the running/idle indicator, English and Simplified Chinese labels, and fade behavior at the top, middle, bottom, and without overflow. Sending a message does not introduce top anchoring.

- Renderer loads a session with a query returning a bounded page of history plus the current head seq, then subscribes with `afterSeq`. Backend pushes committed records in batches after each commit; Renderer folds them into its presentation state. No full snapshots per token.
- Streaming deltas are transient events delivered on the same subscription, coalesced to a short interval, and not stored; the attempt's output is committed when it ends ([agent.md §5.1](agent.md#51-streaming-output)). An `attempt.discarded` event tells the frontend to drop a failed attempt's text before a retry.
- Commands return acceptance, not completion. The UI shows queued, included, running, retrying, interrupted, failed, and completed states from committed records.
- Notices ([agent.md §4](agent.md#4-messages-and-notices)) carry `kind` and `origin`; the frontend decides which kinds to display and how.

### 11.3 Components and style

Use official shadcn/ui components and AI Elements (conversation, message, trace, code block) from the official registry, installed with the CLI into `@whimkit/ui` (`packages/ui/src/components`, §3). Compose and theme them through tokens; do not restyle internals with broad selectors. Vendored files change only through the CLI, except for small edits marked with a `Whim:` comment in the file and listed here: the slider thumb is a primary ring inside a background-colored edge, so it stays distinct over the primary range. Keyboard and focus behavior are part of acceptance.

Whim is a consumer application. The visual direction is friendly and soft rather than dense and formal:

- **Rounded.** Every surface, control, and image uses generous rounding. The theme radius is large (`--radius: 1rem`), and hand-written containers use `rounded-xl` or larger; avatars and status dots are round.
- **Buttons.** Every button has an icon, with a visible label unless it is an icon-only button with an `aria-label`. The confirming action of a group uses the default (primary) variant; Cancel, Close, and similar dismissals use `ghost` (or `link`), never `outline` or primary. Destructive actions use `destructive`.
- **Busy state.** A button or control that runs business logic shows a spinner in place of its icon and is disabled until the command settles, so the interface never appears frozen. Errors from it are reported, not swallowed. Pure dismissals (Cancel, Close) need no busy state. `ActionButton` and `useAction` in `src/renderer/components` implement this.
- **Dialogs.** Header and footer stay fixed; only the body scrolls, and the dialog never exceeds the viewport.
- **Choices.** Single-choice pickers (model, thinking level, language, credential type, enum fields) are `DropdownMenu` radio menus behind a button trigger (`ChoiceMenu`). The shadcn `Select` component is not used; lint forbids importing it outside vendored code.
- **Vocabulary.** The UI speaks in user terms. Internal design concepts such as cards, layers, adapters, or slots do not appear in visible text: a card is a "model", a slot is a "default model".
- **Turns.** Everything the agent does between two user messages (every model call, its thinking, tool calls, notices, and answers) renders as one assistant message. Once the turn is over it gets one footer: a copy action for its answers and the time it took (the duration alone, no prefix), from the user message to the turn's last committed entry. A user message has a footer at its end with a copy action and its send time: the time alone today, "Yesterday" and the time for yesterday, the date and time before that (with the year outside the current one). Footers are secondary (muted color, small icon) and appear only while the message is hovered or focused. Reasoning shows its duration ("Thought for 12s") from the reasoning block's recorded `durationMs`.
- **Theme color.** The default theme is one primary color (`--primary`, with its foreground), and plugin themes (§5.7) may change any documented token, so every component must look right when only tokens change. `primary` marks what is chosen or active: the filled part of a slider, the selected value, the confirming button. Labels and headings beside a choice use `muted-foreground` or `foreground`, never `primary`, and `foreground` never stands in for "selected".
- **Durations.** At most two units, the largest first: hours and minutes, minutes and seconds, or seconds alone; a zero lower unit is dropped ("2m", not "2m 0s").
- **Edge alignment.** A bordered or tinted surface inside the text column (a confirmation card, an inset panel) widens past the column by its own horizontal padding (a negative margin of the same size), so its icon and actions line up with the text edges above and below. Its padding matches its corner radius, so content never crowds the curve.
- **Icons.** Plugins and models show the vendor's logo whenever one exists (§5.1), with its source and license noted in the plugin's `docs/providers/` page; a generic glyph is only the fallback when no logo is available. Activity lines in a chat keep action glyphs (search, read, run), since they describe what happened rather than who provided it. A shell command's line reads "Ran command" followed by the summary the model gave in Bash's `description` (the command itself when there is none, and in full when the line is expanded), because a compound command does not fit on one line and says little at a glance. Compact controls such as the model button under the input show text only.
- **Type.** The platform UI font (SF Pro on macOS) with grayscale antialiasing. Regular weight is the default; `font-medium` marks only titles and labels that must stand out, `font-semibold` only page headings. Selection is shown by surface, not weight. Hierarchy within a control comes from color: the primary value (model name) is darker than its qualifier (thinking level).
- **Markdown.** Model output renders through `components/markdown.tsx`. Streamdown only parses and lays out text: paragraphs, headings, lists, emphasis, inline links, and math (KaTeX). Anything with chrome is a shadcn component mapped through Streamdown's `components`: fenced code is `CodeBlock` (the filled `radix-rhea` style, highlighted with the CLI's `useHighlightedCode`), tables are `Table`, and the link confirmation is a `Dialog` through `linkSafety.renderModal`. Streamdown's own controls (code, table, image, Mermaid) are turned off. When a new Markdown element needs chrome, map it to a shadcn component the same way; never style or keep Streamdown's widget. Links open in the system browser through Main; the app window never navigates or opens Electron windows.
- **Status boxes.** Errors, warnings, and notices use `StatusAlert`: border, background, icon, and text share one hue per tone (red, amber, blue), with the border darker than the tinted background. Red text alone is not an error state.

### 11.4 Coding page

The first slice of [coding-agents.md](research/coding-agents.md): coding CLIs run in tmux, and the page attaches a real terminal to them. Nothing about a session is stored by Whim; tmux is the source of truth, so sessions survive Whim quitting or Backend restarting and can be opened from any other terminal.

- **Agents.** Plugins register coding agents (`codingAgents`, §5.5): an id, a name key in the plugin's catalogs, and a command (argv). `@whimkit/plugin-claude-code` runs `claude`, `@whimkit/plugin-codex` runs `codex`. Whim does not install the CLIs; a missing one shows its own error in the terminal.
- **Computers.** This Mac, or an SSH host saved in the setting `coding.hosts` (a label and an OpenSSH destination, `user@host` or a `Host` alias). A destination that could be read as an option or shell syntax is refused. Sign-in uses the user's SSH config and keys through the system `ssh`; listing runs with `BatchMode=yes`, and every command shares one `ControlMaster` connection per host (sockets in `/tmp/whim-<uid>`, kept 60 s). That directory must be owned by the user and closed to others, or Whim refuses to use it. The path is short because a socket path holds at most 103 bytes, including the 40-character `%C` hash and the 17 characters OpenSSH appends while binding. The data folder under `~/Library/Application Support` is too long for that. `ControlPath` is quoted, because OpenSSH splits option values on spaces; when the path would not fit, the connection is not shared. Whim stores no SSH secret.
- **Sessions.** `coding.sessions` lists a computer's tmux sessions (polled every 5 s while the page is open, one request at a time); it reports tmux missing or the host unreachable as states, not errors. `coding.create` resolves the folder on that computer (absolute, `~`, or `~/…`; a missing folder is an error rather than a silent start in home), then in one tmux command creates a detached session named `<agent>-<6 hex>`, tags it with the user option `@whim-agent`, and types the quoted command into its shell, so the shell survives the agent exiting. Sessions are identified by server pid, session id, and creation time, so a reused name or a restarted server never addresses the wrong one. `coding.kill` ends a session after confirmation.
- **Terminals.** `terminal.open` starts `tmux attach-session` (over `ssh -t` for a host) in a PTY (`node-pty`) owned by Core's `Terminals`, bound to the window's scope: replacing or closing the window detaches, and the session keeps running. Output goes to the Renderer as `terminal.output` events, input and resizes come back as calls, and the view (xterm.js with the fit addon) acknowledges rendered characters; Backend pauses a PTY with more than 1,000,000 unacknowledged characters and resumes it below 250,000. Closing the view detaches; when the attachment ends or Backend restarts, the view offers Reconnect, and reattaches by itself once Backend is back.
- **Where it opens.** The page opens on the computer last chosen and that computer's last opened session; each computer remembers its own. This is a view preference of the window, kept in Renderer `localStorage`, not business state. A remembered session opens only once a listing shows it still exists, since a restarted tmux server gives sessions new keys; one that is gone is forgotten and the page shows its empty state. Once open, a failed listing does not close the terminal.
- **Look.** The terminal fills its panel edge to edge and is always dark, in light mode too. Coding CLIs draw most of their interface in true color tuned for a dark background, and a terminal theme cannot change those colors. Its theme (`terminal-theme.ts`) sets the background, foreground, cursor, selection, and the 16 ANSI colors from Tailwind's 400 and 300 shades. Sessions Whim starts also get a matching tmux `status-style` in place of tmux's green; sessions started elsewhere keep their own.
- **Not yet.** Recording, native log collection, status from the agents, and Whim-agent tools over terminals ([coding-agents.md §5–§8](research/coding-agents.md)).

## 12. Observability

Instrument agent steps, model attempts, tool calls, compaction, and commits with the OpenTelemetry API; the application owns SDK and exporter setup and runs normally without them. Spans end on every terminal path and propagate across IPC and worker boundaries explicitly. Prompts, outputs, reasoning, file content, credentials, and provider error messages are never put in default spans.

## 13. Versions and releases

Application, Core, agent, libraries, and first-party plugins release at one shared version. Database schema versions, record versions, and card revisions are independent of it. A binary rollback does not imply the database can be downgraded.

### 13.1 Packaging

- The macOS app is built with electron-builder from `apps/desktop` (`pnpm --filter @whimkit/desktop package`), one app per architecture (arm64 and x64), as `dmg` and `zip`. Signing and notarization are added with the release pipeline; until then the builds are unsigned.
- Main, Backend, the DB worker, the renderer, workspace packages, and bundled plugins run from the `app.asar` archive. A file another process executes cannot run from the archive, so it is listed in `asarUnpack` and placed in `app.asar.unpacked`; the code that spawns it maps the path. Today that is ripgrep (`@vscode/ripgrep` resolves the binary from its per-platform package, and `@whimkit/tools` rewrites `app.asar/` to `app.asar.unpacked/` before spawning) and `node-pty`, whose N-API addon and macOS `spawn-helper` are unpacked as a whole package (it maps the helper's path itself). `node-pty` is pinned to `1.2.0-beta.18`: the 1.1.0 package ships its macOS `spawn-helper` without the execute bit, so every terminal fails with `posix_spawnp failed`; return to a stable release once one includes the fix.
- Only `@whimkit/*` packages are `dependencies` of `apps/desktop`, because they are loaded at runtime from `node_modules`; everything Vite or esbuild bundles is a `devDependency`, so it is not copied into the archive a second time.
- `electron-builder-squirrel-windows` is a direct `devDependency` although Whim builds no Windows installer: it and `app-builder-lib` are peers of each other, and pnpm hangs while auto-installing that cycle. `electron-winstaller`'s install script is denied in `allowBuilds` for the same reason.
- Each app carries only its own architecture's ripgrep. The workspace installs both darwin binaries (`supportedArchitectures` in `pnpm-workspace.yaml`), so either architecture can be built on any Mac.
- The packaged build is checked by running Grep in it: a path left inside the archive fails with `ENOTDIR` only in the packaged app, never in development.

## 14. Verification

- Store, migrations, idempotency, and projection rebuilds run against real temporary SQLite databases. Crash safety is tested by killing real processes.
- Adapters are tested with recorded protocol fixtures covering success, every mapped error, truncation, cancellation, and missing usage. Live tests are labelled with model, region, and date; a skipped credential is not a pass.
- Electron process lifecycle, native modules, and plugin loading are validated in the real Electron runtime on macOS.
