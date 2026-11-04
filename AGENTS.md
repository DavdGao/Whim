# Whim Development Rules

These rules apply to developers and coding agents working in this repository. `CLAUDE.md` imports this file directly; it must not maintain a separate set of rules.

## Project and design authority

Whim is a macOS Electron workspace built with TypeScript, React, and pnpm workspaces. [docs/design.md](docs/design.md) defines its architecture, interface semantics, persistence boundaries, and implementation sequence. Read the relevant design sections before working on a task, then verify the actual code.

- The design document defines the architecture; this file defines how to develop it. When changing an invariant, update the design and explain the reason in the same change before implementing it.
- When the user explicitly changes a requirement, update the affected documentation. Do not use an old design to reject a new requirement or treat implementation convenience as a new requirement.
- The repository is being established. Planned packages, interfaces, and checks may not exist yet. Type sketches, placeholders, and commands that succeed without doing any work are not completion evidence.
- The first release supports DashScope Chat through the Responses protocol and Decision through the TypeSafe System One protocol. Add TTS, vector storage, other providers, and later product capabilities only as their tasks require.
- Target macOS only. Do not add Windows compatibility branches. Track model tokens, not prices or monetary costs.

## Working process

1. Establish the problem, scope, and verifiable outcome. Confirm that a reported defect exists before fixing it, reproducing it where needed. Verify external interfaces against the relevant official documentation and actual behavior.
2. Inspect the working tree, target module, callers, and existing tests before editing. Preserve the user's changes; do not overwrite, revert, clean up, or reformat unrelated files.
3. Complete the smallest end-to-end change that solves the task. Do not build unused frameworks, generic rule engines, compatibility layers, or empty plugins in advance. Keep unrelated refactoring separate.
4. Make routine implementation decisions within the authorized scope. Ask only when missing information materially changes the outcome, and identify the concrete ambiguity. Do not repeatedly ask for already granted authorization.
5. When changing an interface, inspect its producers and consumers. When changing state, inspect creation, reading, mutation, recovery, and shutdown. A single successful screen or request is insufficient.
6. Report what changed, what was verified, and what remains limited. Distinguish proposed behavior, source-supported behavior, passing tests, and live integration results.

## Package and module boundaries

Keep the foundational packages `@whimkit/core`, `@whimkit/models`, `@whimkit/agent`, and `@whimkit/ui`, assembled by `apps/desktop`. External capabilities belong in plugin packages; application pages initially belong in feature directories.

- Keep contracts in core. Use public subpath exports for browser-safe types, clients, plugin interfaces, and the Node runtime. Do not create a package for every internal module.
- Models must not depend on Electron or the core runtime. Agent accesses persistence and capabilities through ports; core must not import agent. Desktop selects and injects implementations.
- Plugins depend on public interfaces. Do not import another package's `src`, unexported files, or another plugin's implementation.
- Implement each business operation once. UI actions and agent tools call the same command service instead of maintaining separate database or external-operation logic.
- Introduce interfaces where implementations need to be replaceable. Do not wrap ordinary functions in unnecessary factories, managers, services, or base classes.
- A new public interface must have a distinct responsibility, applicable implementations, and defined error and cancellation semantics. Do not add provider-specific methods to a common interface for one adapter.
- Explain the concrete need for a new dependency or package. Prefer existing dependencies and platform capabilities. Avoid dependencies for a few lines of simple logic, and update the lockfile with dependency changes.

## TypeScript and code style

- Write application and plugin code in TypeScript and React components in TSX. Publish ESM JavaScript and declarations. Tool configuration may use the format required by its runtime.
- Keep strict type checking. Treat external JSON, IPC, and plugin input as `unknown` until runtime schema validation narrows it. Do not hide unhandled states behind `any`, double casts, or non-null assertions.
- Use discriminated unions for message, record, model, and result variants, with exhaustive handling where practical. Do not represent incompatible states as a collection of optional fields.
- Give public APIs explicit parameter, return, and error contracts. Prefer inference for local implementation details. Keep public schemas and types in one source instead of maintaining duplicate DTOs.
- Use English identifiers that express business meaning. Give functions and components focused responsibilities. Avoid deep nesting, implicit global state, and business side effects at module import time.
- Do not extract helpers merely to shorten code. Keep trivial, semantically empty forwarding logic at its one or two call sites. Extract complex logic when it has a clear, independently meaningful responsibility.
- Give shared mutable state an explicit owner. Pass dependencies through parameters, constructors, or plugin context rather than mutable global singletons.
- Import required dependencies statically. Load optional capabilities on demand when appropriate; arbitrary dynamic imports are not a decoupling strategy.
- Preserve error causes and relevant operation context. Distinguish cancellation, validation errors, temporary unavailability, failure, and unknown outcomes. Do not swallow errors, leave empty catches, or fabricate successful results.
- Write documentation and code comments in English. Comments explain purpose, invariants, and non-obvious choices rather than restating code. Follow the configured JSDoc checks, usually keeping explanations to one or two lines; put longer design reasoning in documentation.
- Follow `.prettierrc` and `eslint.config.mjs` for formatting and import order. Do not disable rules, weaken strictness, or ignore whole files to make checks pass.

## Async execution, processes, and resources

- Use native async network I/O, `fs/promises` for files, and asynchronous spawn for subprocesses. Do not use synchronous network operations, `execSync`, or blocking polling in runtime paths.
- Run the synchronous SQLite driver only in the dedicated DB worker. Business code accesses an asynchronous Store. Adding `async` to a synchronous function does not remove blocking.
- Every async task needs an owner, exit condition, and error handling. Register persistent work with its scope; do not leave untracked promises, timers, listeners, or subprocesses.
- Pass `AbortSignal` through long operations and use reasonable timeouts and bounded concurrency. A cancellation request, actual termination, and remote rollback are different outcomes.
- Allow only one runner to advance a session's context. Bound concurrency across sessions through the scheduler; do not start the entire backlog with an unbounded `Promise.all`.
- Use `AsyncIterable` or platform streams with defined backpressure, failure, termination, and consumer-disposal behavior. EOF does not imply successful completion.
- Packages and sessions do not each receive a thread or process. Trusted plugin host entries initially share Backend with Core and the agent runner. Add workers or separate processes when measured CPU work or isolation needs justify them.
- Renderer code must not access Node, SQL, or arbitrary IPC directly. Preload exposes typed application interfaces; validate IPC data at both ends.
- Unmounting a page ends its UI subscriptions, not the background sessions it observes. Shutdown stops admission, drains or cancels work, disposes resources, and then closes the database.

## Plugins

- Author plugins in TypeScript and publish compiled artifacts. Read the version from `package.json.version`. Track installation, desired activation, and actual availability separately.
- One plugin package may contain both host and client entries. Host code runs in Backend, client code in Renderer; communicate through typed application interfaces. Sharing a package does not merge their execution or lifecycle boundaries.
- Declare capability dependencies and publish registrations only after initialization succeeds. Roll back resources on initialization failure so the plugin is not partially available.
- Every registration, subscription, and connection has a disposer and belongs to an application, plugin, session, run, or UI subscription scope.
- Stop admitting calls before bounded draining or cancellation, then clean up in reverse dependency order. Disabling or uninstalling code must not implicitly delete business history.
- Bind in-flight calls to a configuration revision and adapter generation. New configuration applies to later calls. Package upgrades take effect after restart; the first release does not hot-swap production code.
- Use the application's commands, queries, and model services. Do not bypass them to write SQL directly or omit model usage accounting. Keep atomic work completion inside Core rather than exposing arbitrary plugin transactions.
- Process isolation is not a permission sandbox. Trusted plugins share Backend's failure domain. An uncooperative host task may require restarting Backend.

## Database and recovery invariants

- Use one SQLite business database. Store credentials in macOS Keychain and references in the database. Do not put credentials, request headers, or full request bodies into diagnostic logs.
- Preserve the complete agent state as append-only records: messages, state transitions, tasks, compaction, plans, attempts, effects, and usage. Stable record IDs and ordered session sequences must support replay and future immutable-prefix forks. Mutable agent views must be rebuildable.
- Global activity is only an atomic operation index with references, without logical content or a duplicate execution-result state machine. Do not impose a general event-sourcing framework on unrelated settings.
- Keep parameterized SQL inside core's storage implementation. Send each short transaction to the DB worker as one operation. Do not await network I/O inside a transaction or hold it across RPC calls.
- Commit accepted input, execution intent, related activity entries, and projections together before acknowledging acceptance. Commit consumption results, successor work, and delivery acknowledgments together.
- Deduplicate commands by stable operation ID: the same ID and input return the original receipt; the same ID with different input is a conflict. Acceptance does not mean an external task has finished.
- Store content once and reference immutable records elsewhere. Activity entries contain operation types and references, without content, duplicate outcome state, arbitrary payloads, or metadata that conceals content.
- Model records, context views, checkpoints, compaction summaries, and UI events separately. Uncommitted stream fragments are not durable messages.
- Compaction never deletes original records or resets task/state history. Forks preserve a fixed prefix and create fresh execution ownership; they must not re-execute inherited effects or count inherited usage again.
- Separate journal head, frozen context, and execution generation. Queuing new input must not invalidate an otherwise valid in-flight result or cause a model retry for a local version conflict.
- In-memory queues and IPC notifications only accelerate processing. Recover unfinished work from the database on startup, reconnection, and reconciliation. Consume by advancing positions or writing acknowledgments, not by deleting message bodies.
- Persist intent and a stable effect ID before external effects. Handle the remote-success/local-commit gap through reconciliation, idempotent retry, or an unknown outcome. Do not claim exactly-once execution for arbitrary external calls.
- Check outcomes after timeouts or cancellation before retrying operations with possible duplicate effects. Reject commits from stale execution generations.
- Append database migrations; never edit a released migration. Storage changes must account for old-record decoding, projection rebuilding, backups, and failed-upgrade recovery.
- Keep application versions, database schema versions, and model card revisions distinct. A binary rollback does not imply that the database can be downgraded.

## Models

- Every model has a ModelCard. Distinguish provider, adapter, model card, and connection. Cards contain capabilities and limits, never pricing or fee fields.
- Give Chat and Decision separate call interfaces. Chat-generated JSON is not a substitute for a dedicated Decision model.
- Keep unknown capabilities distinct from unsupported ones. A provider feature not implemented by the adapter is not available to callers. Distinguish native web search/fetch from application tools.
- Verify the actual endpoint, region, model, and protocol. SDK parameter availability does not prove compatible-service support. Maintain evidence sources and verification dates with cards.
- Add conditional parameter rules incrementally, but reject known invalid combinations from the first release. Do not silently switch thinking modes or protocols, or truncate context.
- Give every actual request its own attempt and record reported usage. Missing token fields remain unknown. Do not double-count cached or reasoning subsets, or mix estimates with reported consumption.
- Let the runtime own retries so hidden SDK retries cannot bypass attempt and token accounting. Do not fabricate complete usage after a failure, interrupted stream, or crash.
- Build main-chat context from local facts without requiring remote conversation IDs for recovery. Preserve protocol continuation fields, not just visible text.

## Frontend

- The project is English-first, including documentation, identifiers, comments, and commit titles. The frontend must offer English and Simplified Chinese from the initial shell, with a persistent language selector.
- Put application and plugin UI strings in typed en/zh-CN catalogs, including accessibility labels, errors, and loading states. Verify key parity and English fallback. Never implicitly translate user content or model output.
- Use shadcn/ui, Tailwind CSS, and lucide-react. Keep shared components and tokens in `@whimkit/ui`; reuse them instead of adding a parallel design system.
- Keep data access in typed clients and hooks. Components render props and hook state and submit commands; they do not implement backend business operations.
- Give each component a focused purpose and organize business code by feature. Core owns persistent business state; React state manages presentation and transient interaction.
- Show loading, empty, error, unavailable, and running states explicitly. Do not show acceptance and completion as the same success state.
- Preserve keyboard interaction, focus behavior, labels, and basic accessibility. Mouse interaction or static screenshots alone are insufficient validation.
- Register plugin UI through named slots instead of modifying host DOM. Share React/UI runtime modules, precompile scoped styles, and avoid duplicate global preflight CSS.

## Files and observability

- Keep managed artifact bytes and immutable metadata in the same SQLite database initially. Enforce explicit size limits. Exports and caches are derived copies, not sole authoritative content.
- User-selected workspaces remain external mutable files. Persist the exact content consumed into durable context, and use a Core-owned file service with root/path validation and explicit write intent. Filesystem writes follow external-effect recovery rules.
- Instrument agent turns, model attempts, tool calls, compaction, and commits with OpenTelemetry. The application owns SDK/exporter setup; libraries use the API and remain functional with no SDK or exporter.
- Preserve tracing context across async streams and explicitly propagate it across IPC/worker boundaries. End spans on every terminal path. Trace IDs are correlation fields, not business IDs or recovery state.
- Never put prompts, completions, thinking, task/file content, credentials, or full tool payloads in default traces. Export failure or sampling must not affect business commits or token accounting.

## Tests and verification

- Test behavior and invariants rather than reproducing implementation line by line. Add regression coverage that exposes a fixed bug. Documentation-only and low-impact formatting changes do not need business tests.
- Place unit tests near their modules. Compare complete objects and arrays where practical, with literal expected values. Use matchers or injected clocks/IDs for nondeterminism rather than omitting important assertions.
- Test transactions, migrations, deduplication, and projection rebuilding against a real temporary SQLite database. Database mocks do not establish transactional correctness.
- Test crash recovery by terminating and restarting real processes. Throwing an exception alone does not establish crash safety.
- Use model protocol fixtures covering errors, truncation, cancellation, and missing usage. Label live service tests with their environment and results; a credential-related skip is not a pass.
- Give each new functional package the typecheck/build/test scripts it needs. Do not expose successful no-op recursive checks; verify what actually ran.
- Validate native modules, Electron process changes, and plugin loading in the actual Electron runtime. Passing under system Node does not establish desktop compatibility.

The baseline has no executable application packages. Install the pinned workspace tooling with `pnpm install --frozen-lockfile`, then run the existing checks:

```sh
pnpm check
```

Introduce real typecheck, test, and build commands with the first functional packages and run them for affected code before committing or pushing. Use `pnpm --filter <package-name> <script>` to narrow the scope, but validate consumers of shared contracts too. Documentation-only changes require formatting and link/reference checks. Format only changed files; root `pnpm format` mutates the whole repository.

Report missing checks, commands that ran no tests, and pre-existing failures explicitly. Fix failures introduced by the task; do not delete tests, bypass hooks, or modify unrelated code to manufacture a green result.

## Git, releases, and handoff

- Inspect the branch and diff before working. Use a branch/worktree when isolation is needed, without requiring an environment for documentation or read-only tasks.
- Preserve staged and unstaged changes and include only task-related changes in commits. Do not commit, push, publish, or rewrite history without authorization.
- Every commit contains only one English scoped Conventional Commit title: `type(scope): description`, for example `feat(agent): support task records`. The scope is required; the title is at most 100 characters and has no trailing period. The body and footer must be empty. Put rationale in the relevant design document or PR, not the commit body. Follow `commitlint.config.cjs`; do not add AI signatures or tool attribution.
- Validate review findings and their necessity before acting on them. Keep changes within the original objective rather than expanding scope for every suggestion.
- Release all Whim-owned applications, packages, and plugins at one shared version, including unchanged packages. Pin internal published dependencies to that version. Third-party dependencies keep their own versions.
- Publish and verify the complete package set before releasing its manifest and desktop application. npm multi-package publication is not atomic.
- Handoffs state the outcome, checks actually performed, and remaining limitations. Plans, placeholders, mock demonstrations, and unexecuted acceptance criteria are not completed implementations.
