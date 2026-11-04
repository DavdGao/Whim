# Implementation Roadmap

This plan follows [design.md](design.md). The repository baseline contains documentation and tooling only. Later stages are not implemented. Complete each stage's acceptance gate before treating it as delivered; do not create empty feature packages to represent progress.

## 0. Repository baseline

Keep the design, shared development rules, a short README, pnpm workspace and lockfile, formatting/lint configuration, hooks, and shared TypeScript compiler options. Remove incomplete code sketches and exclude machine/IDE artifacts from Git.

Verify `pnpm check`, local document references, and commitlint acceptance/rejection cases. Commit only a scoped Conventional Commit title, with an empty body and footer. No runtime, API, tracing, or recovery behavior is claimed by this baseline.

## 1. Agent records and deterministic views

Create the first functional core/agent contracts and package checks. Define stable record IDs, per-session sequences, typed Entry/Block records, accepted input versus context inclusion, state transitions, task revisions, and compaction records.

Implement deterministic folding of context, tasks, and state. Keep effect identity separate from model tool-call IDs and execution generation separate from the journal head.

Acceptance: complete expected views for append, task updates/removal, repeated compaction, tool-pair retention, and a fixed historical prefix. Compaction preserves original facts. Future fork prefixes can be replayed without observing later parent writes. This stage performs no live model calls.

## 2. SQLite journal and atomic work completion

Implement real SQLite migrations, the dedicated DB worker, input acceptance, record append, projections, idempotent operation receipts, and Core-owned work completion. Add configuration revisions, minimal activity, and internal inbox references without a public generic plugin database/message framework.

Acceptance: accepted input survives restart; duplicate operations do not duplicate content; changed input under the same operation ID conflicts; output, delivery acknowledgment, successor work, and projections commit together. New queued input does not invalidate an active execution. Rebuilt views match the journal.

## 3. Desktop runtime, bilingual shell, and tracing setup

Create Electron Main, Renderer, and Backend, with the DB worker inside Backend. Add typed preload/IPC, supervision, shutdown, and reconnect queries. Establish shared UI components, en/zh-CN catalogs, and a persisted language selector before feature screens proliferate.

Initialize OpenTelemetry once in the application, propagate context across IPC and worker messages, and make export optional. Libraries remain usable without SDK setup.

Acceptance: real Electron startup/shutdown, language switching and key parity, no Node access from Renderer, correctly related test spans, and normal execution with tracing disabled or its exporter failing.

## 4. Model cards and bundled DashScope Chat

Implement `@whimkit/models`, capability validation, connection configuration, token usage types, and one bundled `plugin-dashscope` package. Its Chat adapter uses the Responses-compatible route. Add the minimal host registration and disposal lifecycle; do not implement runtime npm installation.

Instrument each actual model attempt, including streaming completion, errors, cancellation, retries, and iterator disposal. Keep content out of default spans. Use fixtures before the smallest live call against a configured account.

Acceptance: request mapping, supported parameter validation, terminal-event handling, unknown usage fields, independent attempt accounting, bounded concurrency, and context isolation between concurrent traces. No implicit SDK retries bypass accounting.

## 5. Main agent loop, tasks, and context compaction

Connect durable input to the agent runner, model service, validated tools, and atomic result commits. Queue new user input FIFO for the next turn. Add stable task IDs and append-only task transitions. Implement context estimation and explicit compaction with immutable coverage and retained-tail references.

Trace each turn, model attempt, tool execution, compaction, and commit. Retain known usage even when a late answer is ineligible to advance a cancelled run.

Acceptance: input-to-answer recovery; state/tasks/context reconstruct after restart; compaction failure leaves the previous context intact; no broken tool pairs; pending external effects are not regenerated or blindly replayed; local version conflicts do not repeat model calls.

## 6. DashScope Decision adapter

Register a separate System One-compatible Decision adapter inside the same provider plugin. Implement choice, score, and noul contracts, independently from Chat. Use caller-owned immutable state references where available.

Acceptance: typed results, probability semantics, validation, reported input-token usage without invented totals, tracing, cancellation, and a minimal configured-account integration. A decision request is not required before every chat turn.

## 7. Files and managed artifacts

Implement the Core-owned file service, managed BLOBs and artifact metadata in SQLite, bounded imports, exports, and explicitly selected workspace roots. Snapshot exact consumed content for durable context. Keep mutable workspaces distinct from managed artifacts.

Acceptance: atomic managed-content commits, hash verification, size limits, path traversal and symlink checks, changed-file conflict handling, export failure without losing owned content, and backup/restore containing managed bytes. External writes preserve unknown outcomes where reconciliation is unavailable.

## 8. Conversation UI and a plugin with both entries

Build chat history, streaming/queued states, tasks, compaction visibility, model/plugin settings, and token usage. Exercise one bundled plugin with both host and client entries using typed commands and subscriptions; use a fixture if a product plugin does not yet need custom UI.

Acceptance: both languages cover screens and accessibility labels; switching pages does not terminate work; client disposal does not cancel host tasks; streamed and committed results are distinguishable; UI and tools share the same business operations.

## 9. Recovery and release gate

Exercise real process/worker termination around acceptance, model completion, database response loss, compaction, and external-effect boundaries. Verify stale execution rejection, blocked incompatible plans, explicit replanning, projection rebuilding, and consistent backups.

Validate the packaged macOS application, native SQLite module, unified package versions, and an offline/no-exporter configuration. Record actual model/region/runtime versions used for live tests. Do not claim lossless token accounting when upstream usage was never received.

## 10. Subsequent product capabilities

Add fork commands/UI at committed turn boundaries using immutable parent prefixes, fresh execution ownership, and nonduplicated usage. Then add ACP sessions, information-source subscriptions, music controls, and dashboard widgets according to the next requested product workflow.

Implement dynamic npm installation, plugin data migrations, independent plugin processes, or large-file storage only when a concrete integration requires them. Define their data ownership and recovery contract before implementation. All frontend extensions must participate in the English/Chinese language system.
