# Agent Design

This document defines how the agent runs a session: records, messages and notices, runs and interruption, errors and retries, context sources and the prompt cache, compaction, tools, permissions, skills, memory, and middleware. [design.md](design.md) owns processes, plugins, credentials, model cards, storage, and the frontend.

## 1. Ownership

| Owner             | Responsibility                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| Core              | Journal, commands, inbox, context sources, Job service, tool registry, permissions, attachments, model slot binding |
| `@whimkit/agent`  | The run generator: prepare a step, call the model, commit output, schedule tools, decide whether to continue        |
| Backend scheduler | Starts runners when sessions have work, one runner per session, bounded concurrency across sessions                 |
| Adapter (plugin)  | Translate a frozen request into provider calls and normalize the stream and failures                                |
| Renderer          | Observe committed records; submit commands                                                                          |

The agent is an async generator consumed by the Backend scheduler, never by a UI subscription. It yields two kinds of values: committed records, and transient stream events (§5.1) that are never stored. The agent reaches Core only through ports (store, model slots, tools, jobs, sources), so it is testable with fixtures and a real SQLite store.

## 2. Session state

A session's state is the fold of its journal:

- **Epoch** — the frozen prefix: system sections, tool declarations, the frozen card, source snapshots, and the notice renderer version. Replaced by compaction or a model switch.
- **History** — committed context items appended after the epoch: messages, tool calls and results, notices.
- **Inbox** — accepted deliveries not yet consumed by a reasoning step.
- **Runs** — one active run at most. A run is a sequence of steps; each step makes one or more model attempts.
- **Jobs** — tool executions owned by Core's Job service, referenced from history.

A session has a **workspace**: a directory the user picks when creating it, or `~/Whim` (created on demand) when they pick none, fixed for the session's life. Sessions from before this default may have none; workspace tools are offered only with a workspace, and the epoch's system prompt is the user's agent profile (name and instructions from Settings) followed by the workspace path, platform, and date as of the epoch's start. Profile edits therefore reach a session only at its next epoch.

The journal head (latest seq), the epoch, and the run generation are separate values. New input advances the head without invalidating an in-flight step.

## 3. Records

Each record has `id`, `sessionId`, `seq`, `type`, `version`, `createdAt`, `operationId`, and a typed body. Bodies are discriminated by `type`; incompatible states are separate variants, not optional fields.

| Record                                       | Written when                                                                 | Key fields                                                                                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `session.created`                            | Session creation                                                             | title, credential, thinking level                                                                                                      |
| `session.updated`                            | Rename, credential change, thinking level change                             | changed fields; none of them alter the prompt prefix, so they apply to the next attempt                                                |
| `epoch.started`                              | Creation, successful compaction, model switch                                | `epochId`, `reason`, system sections, tool declarations, frozen card, source snapshots                                                 |
| `delivery.accepted`                          | Input admitted to the inbox                                                  | `deliveryId`, `placement`, item (message or notice)                                                                                    |
| `delivery.withdrawn`                         | User removes a pending item                                                  | `deliveryId`                                                                                                                           |
| `run.started`                                | Scheduler begins a run                                                       | `runId`, trigger                                                                                                                       |
| `step.prepared`                              | Before reasoning                                                             | `stepId`, consumed delivery ids, plan (epoch id, history end seq, estimate)                                                            |
| `attempt.started`                            | Each model request                                                           | `attemptId`, `stepId`, attempt number                                                                                                  |
| `attempt.finished`                           | Attempt terminal                                                             | `status` (completed, failed, interrupted), usage, failure; for completed and interrupted attempts, the output (text, reasoning, items) |
| `retry.scheduled`                            | Runtime decides to retry                                                     | `stepId`, next attempt number, `at`, failure that caused it                                                                            |
| `interrupt.requested`                        | Stop or shutdown                                                             | `runId`, `reason`: user, shutdown, or plugin-removed                                                                                   |
| `run.ended`                                  | Run terminal                                                                 | `{ outcome: 'completed' }` / `{ outcome: 'interrupted', reason }` / `{ outcome: 'failed', failure }`                                   |
| `compaction.started`                         | Compaction begins                                                            | `compactionId`, trigger                                                                                                                |
| `compaction.finished`                        | Compaction terminal                                                          | `{ status: 'succeeded', epochId, coveredSeq }` / `{ status: 'failed', failure }`                                                       |
| `permission.requested`, `permission.decided` | A call needs the user's decision ([§10](#10-permissions))                    | `callId`, access / decision and scope                                                                                                  |
| `tool.started`, `tool.finished`              | A call starts / gets its result ([§9.2](#92-calls-and-results))              | `callId`, `jobId` / result item                                                                                                        |
| `job.ended`                                  | A background job ends or is lost ([§9.4](#94-jobs-and-background-execution)) | `jobId`, status                                                                                                                        |

Usage is recorded on every `attempt.finished`, including failures, with missing fields left unknown. Compaction and reviewer attempts are attempts too.

## 4. Messages and notices

A context item is a message `{ id, role: 'user' | 'assistant', blocks }`. Blocks are a discriminated union: `text`, `image`, `file` (artifact reference plus prepared content), `reasoning` (with the measured `durationMs` from its first delta to the first answer delta), `continuation`, `tool_call`, and `native_tool_call`. Tool results (§9.2) and notices are context items of their own.

A notice is how anything other than the user tells the agent something:

```ts
type Notice = {
    type: 'notice';
    id: string;
    kind: NoticeKind;
    origin:
        { type: 'core'; service: string } | { type: 'plugin'; pluginId: string } | { type: 'user' };
    observedAt: string;
    payload: NoticePayload[NoticeKind];
    content?: readonly (TextBlock | ImageBlock)[];
};
```

- `kind` selects a payload schema. Core kinds: `interrupted`, `restarted`, `job-finished`, `job-lost`, and later `source-changed` and `clock`. Plugin kinds are `<pluginId>#<name>` with a payload schema registered by the plugin. No information is passed by encoding JSON into strings.
- `content` holds optional model-facing text or images, for example a background job's output preview.
- A versioned Core renderer turns notices into model input wrapped in `<system-reminder>…</system-reminder>`, carried in a user-role message. Changing the renderer is prompt-affecting and is recorded in the epoch.
- The frontend decides display from `kind` and `origin`. Records carry no display flags.

Producers **push** notices and messages into the durable inbox at any time and wake the scheduler. The agent **pulls** at reasoning boundaries: `step.prepared` consumes exactly the deliveries it includes, in one transaction with the plan. In-memory wakeups only accelerate this; on restart the inbox is read from the database.

Deliveries have a placement: `next-step` (included at the next reasoning boundary, including inside a running run, so the user can steer while the agent works) or `next-run` (held until the current run ends). User messages sent during a run default to `next-step`. A pending delivery can be withdrawn until it is consumed.

## 5. Runs, steps, and interruption

```
run:
  loop:
    prepare step  (atomic: consume deliveries + freeze plan)
    if nothing new to respond to: end run
    attempt with retries (§6), streaming transient deltas
    finalize assistant message
    if tool calls: execute (§9), append results, continue
    else: end run
```

- A run with no unconsumed deliveries and no pending tool results ends immediately without calling the model.
- One runner per session. A second start request for a running session is a no-op returning the active run.

### 5.1 Streaming output

Model output is committed once per attempt, when the attempt ends: `attempt.finished` carries the complete output of a completed attempt, or the partial output of an interrupted one. While the attempt runs, deltas are published to subscribers as transient `stream` events tagged with `attemptId`; they are not written to the journal. This keeps the journal to a few records per reply and makes retries trivial: a failed attempt's text was never history.

Trade-off: if Backend crashes mid-stream, the partial text of the running attempt is lost; the attempt is recorded as interrupted with unknown usage. User Stop and shutdown do not lose text, because the runner still holds the buffer and commits it.

**Stop.** The user's Stop writes `interrupt.requested { reason: 'user' }` before any cancellation signal is sent. Then:

- The active attempt is aborted. Its buffered output is committed in `attempt.finished { status: 'interrupted' }`, and the assistant message is finalized as `interrupted` with that text verbatim.
- Running foreground tools are cancelled; background jobs are not (they have their own Stop).
- An `interrupted` notice is delivered so the next step sees `<system-reminder>The user interrupted you.</system-reminder>` after the partial answer and before the next user input.
- Pending deliveries survive. The run ends `interrupted`; the next user message starts a new run normally.

**Shutdown.** Uses `reason: 'shutdown'`. No user-interrupt notice is written; on the next start a `restarted` notice tells the agent its previous response was cut off by an application restart. Whether an interrupted run resumes automatically after restart is a user setting (`agent.resumeAfterRestart`, default off). When off, the session resumes when the user sends input or presses Continue; when on, the scheduler starts a run that sees the `restarted` notice.

**Crash.** On start, Core finds runs without `run.ended`, closes their open attempts as `interrupted` with no output and unknown usage, and proceeds as for shutdown.

## 6. Errors and retries

Adapters throw `ApplicationError` carrying a `Failure` ([design.md §10](design.md#10-errors)). The runtime decides:

- `retry.kind === 'backoff'`: schedule a retry, whether or not output was already streamed. Exponential backoff with jitter, honoring `afterMs`, bounded by a maximum attempt count and total time. `retry.scheduled` is committed before waiting, so the UI shows "Rate limited — retrying in 6 s (2/4)" with a cancel action, and restart resumes the schedule.
- If the failed attempt had streamed output, subscribers receive a transient `attempt.discarded { attemptId, failure }` event. The frontend hides that attempt's text and shows the retry state; the next attempt streams a fresh answer under a new attempt id. The discarded text is never stored.
- `outcome === 'unknown'` on a non-idempotent effect: no automatic retry before reconciliation. Model calls are side-effect free, so for them `unknown` with `backoff` is retried.
- Anything else: the step fails, the run ends `failed`, and the failure is shown with its translated category and the provider detail.
- Each retry is a new attempt with its own id; the failed attempt's `attempt.finished` records its failure and usage, without output. Adapters never retry internally.
- `context-limit` triggers compaction once ([§8](#8-compaction)) before failing.

There is no run-wide timeout. Attempts have an idle timeout between stream events (no bytes for a configured period → `timeout`, `backoff`); tools have their own limits.

## 7. Context sources and the prompt cache

The request prefix — system sections, tool declarations, model route, and every historical item — is identical between compactions. Only appends happen. Only compaction may change the prefix.

### 7.1 Sources

Anything that would otherwise be injected into the system prompt or tool list is a **context source**: the base system prompt, the skill catalog, MEMORY.md, the tool set, clock and environment information, and plugin-provided sources. A source registers:

```ts
interface ContextSource {
    readonly id: string;
    readonly target: 'system' | 'tools';
    snapshot(signal: AbortSignal): Promise<SourceSnapshot>; // { revision, observedAt, sections | tools }
    describeChange(previous: SourceSnapshot, next: SourceSnapshot): NoticeContent; // delta or full, the source decides
    watch?(wake: () => void): Disposable;
}
```

- Revisions are content hashes. Watchers only wake reconciliation; timestamps are hints.
- When a source's revision changes, Core records it in `sources` and delivers one `source-changed` notice to each affected session, deduplicated by `(session, source, revision)`. The notice contains what `describeChange` produced and the observation time.
- Skills describe per-item changes (added / modified with new metadata / removed). MEMORY.md, being a short index, describes its new full content. Other sources choose what is clearer.
- The epoch stores each source's snapshot with its revision and `observedAt`; system sections render that time (for example "Skills as of 2026-11-04 10:21").

### 7.2 Tools as a source

The tool set is a source with target `tools`, so the same mechanism can later carry tool-schema changes between compactions. Dynamic tools are not designed or implemented yet; this section only keeps the source mechanism general enough to host them.

Revocation is immediate regardless of the cache: a disabled tool fails its call with an error result even if it is still declared.

## 8. Compaction

Triggers: the estimated next request exceeds the threshold (80% of the card's context window, the point the composer's context ring fills toward), a `context-limit` failure, or an explicit user request.

1. Commit `compaction.started`. The UI shows progress.
2. Run a summary attempt with the `compaction` slot model over the current history. Its usage is recorded.
3. Take fresh snapshots of all sources and the current tool set and session model.
4. Commit atomically: `epoch.started` (new prefix with snapshots and timestamps, summary as the first history item) and `compaction.finished { succeeded }`.

On failure or cancellation, `compaction.finished { failed }` is committed and the old epoch stays. Deliveries accepted during compaction remain pending. Original records are never deleted; the UI shows a divider with the summary expandable, and older history stays readable.

### 8.1 Model switch

The model selector is disabled while a run is active. Switching between runs starts a new epoch at the next reasoning step without summarizing. The provider cache is lost anyway when the model changes, so the switch also refreshes all source snapshots.

The new epoch re-renders the existing history for the new card:

- Continuation items from a different adapter are dropped; the visible text and reasoning summaries remain.
- Blocks with media types the new card cannot accept become short text placeholders naming the attachment; the originals stay in storage. Before switching, the frontend warns which attachments the new model cannot read.
- Provider-executed tool calls from the previous provider are kept as text records of what was called and returned.
- If the history does not fit the new adapter's `inputBudget`, the switch runs compaction with the new model first.

The switch is recorded as `epoch.started { reason: 'model-switch' }`, and the conversation shows where it happened.

## 9. Tools

### 9.1 Definitions

The base tools are part of the harness, not plugins: `@whimkit/tools` provides `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, and local `WebFetch`, and Desktop hands them to the tool runtime, which adds the job tools (`JobOutput`, `JobStop`). Every agent has them; they cannot be disabled, and a plugin tool with a base tool's name is ignored. A local `WebSearch` needs a keyed search API and is not available yet, so web search is native-only for now. Plugins add further tools through `context.tools.register(definition)`; an MCP bridge would be one more such plugin, and nothing in Core is MCP-specific. Declarations list base tools, then plugin tools in registration order, then the job tools.

```ts
interface ToolDefinition {
    name: string; // model-facing, unique across plugins
    description: string;
    inputSchema: JsonSchema; // Core validates input before anything else
    readOnly: boolean;
    concurrencySafe: boolean;
    needsWorkspace: boolean; // offered only to sessions with a workspace
    standard?: 'web_search' | 'web_fetch'; // local implementation of a standard id (design.md §7.6)
    access(input, env): Access[]; // what the call touches, for permissions
    backgroundAfterMs?(input): number | undefined; // foreground limit; 0 = start in background
    execute(input, context: ToolContext): Promise<ToolOutput>;
}
type Access =
    | { kind: 'read' | 'write'; path: string } // absolute
    | { kind: 'execute'; command: string }
    | { kind: 'network'; url: string };
interface ToolContext {
    signal: AbortSignal; // Stop for foreground calls, JobStop for background ones
    sessionId: string;
    callId: string;
    workspace?: string;
    output(chunk: string): void; // progressive output, readable through JobOutput
}
interface ToolOutput {
    content: string;
    isError?: boolean;
}
```

The tool set is frozen into the epoch (`tools`: name, description, input schema, in registration order) together with `nativeTools`, the native tool ids the adapter will execute. Sessions created before tools existed have empty sets. A tool whose plugin is disabled later stays declared until compaction but fails its calls immediately (§7.2).

### 9.2 Calls and results

A completed attempt may end with `tool_call` blocks `{ callId, name, arguments }`, where `arguments` is the provider's exact JSON text, kept for replay. Calls of an interrupted attempt are dropped and never executed. Each call then goes through:

1. **Validate.** Unknown tool, unparsable arguments, or schema errors produce an error result without running anything.
2. **Permit** (§10). An ask commits `permission.requested`, and the run waits for `permission.decided`.
3. **Start.** `tool.started { callId, jobId }` is committed before execution.
4. **Finish.** `tool.finished { callId, result }` appends a `tool_result` context item: `status` (`success`, `error`, `denied`, `cancelled`, `background`, `lost`), text `content`, and optional `jobId` and `offload`.

Every call gets exactly one result. When a run ends or recovery finds an unfinished call, the missing results are written as `cancelled` (not started) or `lost` (started, outcome unknown), so provider history stays valid. After the results, the step loop continues: a history that ends with tool results needs a response.

Provider-executed calls (web search on DashScope) arrive as `native_tool_call` blocks with the adapter id, the standard tool id, the query or URLs, and the opaque provider item for replay. Core never executes them.

### 9.3 Scheduling

Calls run in order of appearance, grouped: consecutive `concurrencySafe` calls run in parallel (at most 4); any other call is a barrier that runs alone. Non-concurrency-safe calls also take a per-workspace lock, so two sessions never mutate one workspace at the same time. Results are committed as they complete; the request renderer places them in the original call order after their assistant message.

### 9.4 Jobs and background execution

Core's Job service owns every execution; the agent only waits. A call runs as a job and the step waits up to `backgroundAfterMs`:

- Completes in time: its output is the tool result.
- Exceeds the limit, or the limit is 0: the result is `background` with the job id and the output so far, and the job keeps running. `JobOutput { jobId, offset? }` reads accumulated output, `JobStop { jobId }` cancels it.
- When a background job ends, `job.ended` and a `job-finished` notice (status and output tail) are committed together, and an idle session starts a run to react to it.
- Stop cancels foreground jobs only. Jobs do not survive a restart: recovery commits `job.ended { lost }` and a `job-lost` notice.
- One job per call; a handoff never re-runs anything.

### 9.5 Truncation and offload

A result above 32 KiB of text is written to `<userData>/artifacts/<callId>.txt`; the context gets the first and last 8 KiB, the total size, and the file path, which `Read` accepts with offsets and which is readable without a permission prompt. Background job output is bounded the same way. Nothing is silently dropped.

## 10. Permissions

Core decides each call from its `access` list:

| Access                                                          | Default (manual mode) |
| --------------------------------------------------------------- | --------------------- |
| none, or `read` inside the workspace or the artifacts directory | allow                 |
| `read` elsewhere, `write`, `execute`, `network`                 | ask                   |

The user answers an ask with **Allow once**, **Allow for this session**, or **Deny**. A session grant becomes a rule for that tool: a path prefix for files (the workspace), the first word of the command for `execute`, the host for `network`. A denial produces a `denied` result telling the model the user declined. Stop while an ask is open cancels the call.

Records: `permission.requested { callId, name, access }` and `permission.decided { callId, decision, scope }`. Persistent rules in Settings and **auto mode** (a reviewer model deciding asks: a Chat model with structured output or a Decision model behind one contract, falling back to the user on failure, with its attempts recorded) follow in a later change.

## 11. Skills and memory

- **Skills** are directories with a `SKILL.md`. The catalog (name, description, path, revision) is a context source; skill bodies are loaded on demand by the agent through `Read` or a `Skill` tool, so editing a body does not affect the prefix.
- **Memory** is a first-party plugin: MEMORY.md is an index source; detail files are read on demand. Agent edits use the same file service and revision checks as user edits, and both arrive through the same source-change path.

## 12. Middleware

Plugins can contribute to context only by appending: they register a context source, or a step hook that runs before `step.prepared` with a time bound and enqueues deliveries. Hook contributions are keyed by `(stepId, hookId)` so recovery does not duplicate them. Middleware cannot rewrite history, hide terminal states, bypass permissions, or call models outside accounting.

## 13. Admission and context budget

- Input is admitted before acceptance ([design.md §8](design.md#8-attachments)). A single item that cannot fit within the budget even after compaction is rejected; it never wedges the inbox.
- Before each step the agent estimates the request against `inputBudget`, preferring the adapter's `countTokens` and reconciling with reported usage. Above the threshold it compacts first. If the request still does not fit, the step fails with `context-limit` and the user can withdraw pending items.
- Tool results and attachments are bounded by §9.4.

## 14. Acceptance

- Stop during streaming keeps the verbatim partial answer, the next step sees the interrupt notice, and the conversation continues.
- A user message sent during a run is included at the next step without restarting the in-flight attempt.
- Retries are visible and cancellable, survive restart, and also apply after partial output; the frontend replaces the discarded attempt's text.
- Source edits between compactions never change captured request prefixes; compaction refreshes them once with timestamps.
- An oversized message is rejected at submission; a pending item can be withdrawn.
- Killing Backend mid-stream and restarting yields a consistent session with an interrupted message and a `restarted` notice.
- Background jobs complete into notices, `JobOutput`/`JobStop` work, and handoff never re-runs a command.
