# Implementation Roadmap

This plan follows [design.md](design.md) and [agent.md](agent.md). Build the agent and durable context before the desktop UI. Complete each stage's acceptance gate before treating it as delivered; do not create empty feature packages to represent progress.

The first implementation increment is implemented and tested as a headless text-agent path: runtime-validated records, deterministic views, a real SQLite journal in a dedicated worker, atomic inbox consumption, a streaming async generator, durable interrupted output, explicit compaction, task revisions, and OpenTelemetry instrumentation. It uses injected model adapters and deterministic fixtures before introducing live provider APIs. Tool execution/background jobs, automatic approval, live source watchers, and Electron follow later increments; they must not be reported as implemented by this first path. See [runtime.md](runtime.md) for the executable API and limits. This increment covers parts of stages 1–5; it does not satisfy those stages' complete acceptance gates.

## 0. Repository baseline

Keep the design, shared development rules, a short README, pnpm workspace and lockfile, formatting/lint configuration, hooks, and shared TypeScript compiler options. Remove incomplete code sketches and exclude machine/IDE artifacts from Git.

Verify `pnpm check`, local document references, and commitlint acceptance/rejection cases. Commit only a scoped Conventional Commit title, with an empty body and footer. No runtime, API, tracing, or recovery behavior is claimed by this baseline.

## 1. Agent contracts, context epochs, and deterministic views

Create functional core/agent contracts and actual package checks. Define stable record IDs, per-session sequences, typed Entry/Block records, accepted input versus context inclusion, state/tasks, source revisions/delivery, approval facts, and compaction/epoch records. Separate durable records from transient generator events.

Include run interruption/gates, typed inbox placement, and tool jobs as separate execution identities from planning tasks. Define one original tool response versus later background-completion notifications.

Define stable streamed-message IDs, ordered durable chunks, publication/display positions, and append-only finalization. Model interruption context must preserve the exact partial answer and establish causal ordering before resumed user input.

Implement deterministic folding of context, tasks, source revisions, and state. Freeze the system/tool prefix and append immutable context items. Keep effect identity separate from model tool-call IDs and execution generation separate from the journal head.

Acceptance: complete expected views for task changes, source add/edit/delete, notification delivery, repeated compaction, tool-pair retention, and a fixed historical prefix. Successive captured requests retain their previous prefix until compaction. Future fork prefixes exclude later parent writes. This stage performs no live model calls.

## 2. SQLite journal, snapshots, and atomic completion

Implement real SQLite migrations, the dedicated DB worker, input acceptance, record append, projections, idempotent receipts, and Core-owned work completion. Add bounded immutable content snapshots, configuration/rule revisions, source-delivery cursors, minimal activity, and inbox references without a generic plugin database/message framework.

Acceptance: accepted input survives restart; duplicate commands do not duplicate content; changed input under the same ID conflicts; output, acknowledgment, successor work, and projections commit together. Notification insertion and source-delivery advancement are atomic. New queued input does not invalidate active execution. Rebuilt views match the journal.

Implement `prepareReasoning` so context inclusion, exact inbox consumption, source-delivery positions, and the call plan commit together. Verify crashes before/after commit, finite watermarks, next-run gaps, pending input during compaction, Stop/preparation races, and the distinction between input consumption and execution completion.

## 3. Headless agent generator and local tools

Implement the async generator and Backend-style pump with deterministic model/reviewer fixtures. Connect journaled input, model plans, complete responses, tool intents, batches, results, tasks, and terminal states. Implement Core file services and Bash/Read/Edit/Write/Grep/Glob with bounded resources and workspace coordination.

Add Core-owned jobs, foreground wait limits and background handoff, durable output cursors, and JobStatus/JobOutput/JobCancel. Implement targeted Stop, Stop-and-cancel-jobs, resume, and interrupt-and-send. Next-reasoning input may steer an active run without altering an in-flight call.

Implement auto-approval orchestration and tool-aware candidate rules before enabling tool effects. Use fixture verdicts only in tests. Instrument the agent/model/tool/commit boundaries through OpenTelemetry API; test with an in-memory exporter. Production execution stays unavailable until a real reviewer is configured or a valid rule applies.

Acceptance: generator cancellation and cleanup, slow/missing UI independence, ordered parallel groups with serial barriers, cross-session conflicts, complete tool results, rule reuse/revocation, stale-generation rejection, and no duplicated committed effects. Exercise restart with real SQLite and bounded subprocesses.

Verify handoff/completion/Stop races, one handle per original tool call, queued versus running status, dependency barriers after handoff, process-group cleanup, held automatic continuation, and idle job-completion wakeups. A lost executor must not cause blind command relaunch.

Verify commit-before-display, exact partial-answer reconstruction, Stop/chunk races, interrupted tool output, nonexecution of incomplete tool calls, and operation-to-context observations. A resumed "What was your last sentence?" must have the verbatim answer/fragment and known presentation cutoff available, including through compaction.

## 4. DashScope models and both review implementations

Implement `@whimkit/models`, MIME/delivery/request limits, connection configuration, token usage, and bundled `plugin-dashscope`. Main Chat uses Responses; Decision uses System One. Implement the Decision reviewer and structured-Chat reviewer independently behind `ToolReviewer`. Add minimal host lifecycle, without runtime npm installation.

Instrument each actual model attempt through stream completion/error/cancellation/disposal. Keep content out of default spans. Preserve request-prefix serialization and protocol continuation items. Use fixtures before minimal live calls against a configured account; do not assume structured-output/thinking combinations or PDF delivery work because SDK fields exist.

Acceptance: Chat and choice/score/noul mappings, validated reviewer decisions and candidate selections, unknown usage fields, terminal events, separate review/main attempts, prefix invariance, and trace isolation. Verify actual cache reporting separately from local prefix tests. No hidden SDK retries bypass accounting.

## 5. Compaction, runtime instructions, and middleware

Implement context budgets, time/task reminders, append-only middleware contributions, bounded agentic continuations, and explicit/automatic compaction. Atomically replace the epoch only after summary success and candidate validation. Model/tool-prefix changes wait for this boundary.

Trace summary attempts and retain usage even when a result cannot advance the run. Publish durable compaction start/finish facts and transient progress. Keep task state independent from summary text.

Acceptance: failure/cancellation keeps the old prefix; successful compaction refreshes it once; no broken tool pairs; source changes during summary are delivered afterward; hook recovery reuses committed contributions; budgets terminate loops; local conflicts do not repeat model calls.

## 6. Skills and file-memory plugin

Implement bounded skill discovery and lazy loading, hash-based source reconciliation, per-session incremental notifications, and `plugin-memory` with MEMORY.md plus detail files. Manual and agent edits use the same observation/revision path. Memory updates use approved Core writes with expected revisions.

Acceptance: add/edit/delete, atomic-save replacement, changed scripts, missed watcher wakeups, independent session delivery, duplicate-free recovery, concurrent manual edits, bounded large sources, and persisted observation timestamps. All pre-compaction prompt prefixes remain unchanged.

## 7. PDF attachments and provider-native tools

Extend managed artifacts with bounded PDF ingestion, isolated parsing, page-labelled extraction, and ReadPDF. Expose effective attachment limits and preparation states. Main Responses chat can use extracted content; native PDF routes remain disabled until actual ingestion is verified. Add explicit child-model document analysis only with its own working adapter/card.

Enable native search/extraction from effective cards and policy at epoch creation. Map provider progress/citations separately from local tool dispatch; validate native/function-call coexistence and stateless continuation. No hosted vector store is introduced for PDF reading.

Acceptance: byte/page/aggregate/encoded-request/context limits, malformed/encrypted/scanned PDFs, parser timeout and real process death, failed attachments preserving sessions, original/prepared snapshot replay, and backup completeness. Native web tools run once and obey verified dependency/thinking constraints. Native PDF tests must recover unique document content, not merely receive HTTP 200.

## 8. Electron runtime and bilingual conversation UI

Assemble Main, Renderer, Backend, and the DB worker; supervise the on-demand PDF helper. Add typed preload/IPC, shutdown/recovery, SDK initialization and trace-context propagation. Establish en/zh-CN catalogs and persisted language selection with the first shell.

Build chat, tasks, compaction/source updates, approval outcomes/rules, model/plugin settings, attachment states, and token usage. Exercise one bundled plugin with both host and client entries through the same commands and subscriptions.

Show queued versus included messages, agent Stop separately from background-job cancellation, job output/status, and cancellation-requested versus confirmed termination. Keep these states recoverable through queries after page changes.

Render committed stream ranges under one message ID and label incomplete/interrupted content without hiding it. Include the initiating view's display cursor in Stop where available; distinguish published content from confirmed presentation.

Acceptance: actual Electron process lifecycle and native modules, both languages and accessibility labels, admission consistency, no Node access from Renderer, no oversized IPC, no-UI background progress, reconnect from committed state, and normal operation without a trace exporter.

## 9. Recovery and release gate

Exercise real process/worker termination around acceptance, model completion, database response loss, compaction/epoch replacement, source delivery, rule installation, PDF processing, and external-effect boundaries. Verify stale execution rejection, blocked incompatible plans, prefix stability across restart, explicit replanning, projection rebuilding, and consistent backups.

Validate the packaged macOS application, native SQLite module, unified package versions, and an offline/no-exporter configuration. Record actual model/region/runtime versions used for live tests. Do not claim lossless token accounting when upstream usage was never received.

## Required additions to the next increments

- Stage 2/3: Core-managed immutable artifact chunks, materialized offload files, bounded Read/Grep retrieval, and tool effect/environment descriptors. Keep desktop execution; do not introduce a sandbox implementation.
- Stage 5/6: durable asynchronous memory retrieval alongside explicit retrieval, result-to-inbox completion, stale-query handling, cancellation, and reasoning-boundary consumption.
- Stage 7: apply the same offload mechanism to admitted attachments and extracted PDF content, retaining original bytes and provenance separately.

These are required features, not implemented behavior of the current headless text runtime. Acceptance includes cache reconstruction, quota failures, no dangling published references, late retrieval delivery, Stop/supersession races, and prompt-prefix stability.

## 10. Subsequent product capabilities

Add fork commands/UI at committed turn boundaries using immutable parent prefixes, fresh execution ownership, and nonduplicated usage. Then add ACP sessions, information-source subscriptions, music controls, and dashboard widgets according to the next requested product workflow.

Implement dynamic npm installation, plugin data migrations, independent plugin processes, or large-file storage only when a concrete integration requires them. Define their data ownership and recovery contract before implementation. All frontend extensions must participate in the English/Chinese language system.

The provider/runtime increments must implement [errors.md](errors.md): normalized failures, durable retry scheduling, bounded policy, and frontend state derived from the journal. Offload files retain unread originals on disk; consumed context remains in SQLite. Validate coordinated backup and file/database reconciliation rather than treating offload originals as disposable caches.
