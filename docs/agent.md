# Agent Design

Status: implementation specification; the headless text-agent increment is implemented and tested; the broader agent remains under development. Last updated: 2026-11-04. Later tool, provider, and desktop capabilities remain planned.

The first runtime exposes a validated command union through an asynchronous Store port. Core evaluates commands and appends their complete record batch in one SQLite worker transaction; agent never writes SQL. Initially views are rebuilt from the journal rather than maintaining redundant projections. Text-only model requests fail explicitly on unsupported content; they do not fabricate tool execution. Source notifications can enter through the inbox, while live filesystem observation is a later integration. [runtime.md](runtime.md) documents the executable API, verified behavior, and current limits.

This document defines the main agent's execution, context, tools, approval, skills, and memory. [design.md](design.md) owns application topology, ModelCards, storage, attachment limits, and transport. Update the relevant design before changing behavior; [roadmap.md](roadmap.md) gives the implementation order.

## 1. Responsibilities

The main agent is a durable reasoning/action loop with an asynchronous event interface. It consumes accepted user input, constructs append-only context, calls Chat models, approves and executes tools, and commits results. ACP sessions remain independent.

The following ownership boundaries keep model providers, execution, and presentation separate.

| Owner              | Responsibilities                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@whimkit/agent`   | Async generator, deterministic context selection, compaction policy, instruction injection, tool batches, approval orchestration, middleware hooks                              |
| `@whimkit/core`    | Journal and atomic commits, durable inbox, run/job scheduling and ownership, command/query interfaces, files/artifacts, source revisions, permission rules, local tool services |
| `@whimkit/models`  | Chat/Decision contracts, ModelCards, normalized model events and usage                                                                                                          |
| `plugin-dashscope` | Chat and Decision transports, native capability descriptors, provider-event decoding; no local shell/file implementation                                                        |
| `plugin-memory`    | Replaceable file-memory policy and agentic middleware using Core's file and model services; no private database                                                                 |
| Desktop Backend    | Dependency assembly and the always-running consumer of agent generators                                                                                                         |
| Renderer           | Commands and subscriptions, streaming feedback, approval status, tasks, compaction, and attachments                                                                             |

Start with modules inside the existing foundational packages. The file-memory strategy is one bundled host plugin because it is independently replaceable; skills are instruction directories, not one npm plugin each. PDF parsing is a Core file-service module with an isolated helper process, not another database or general plugin platform.

## 2. Async generator and execution ownership

The agent entry point is an asynchronous generator. Its consumer receives progress without implementing reasoning or persistence.

```ts
interface AgentRunner {
    run(input: RunInput, signal: AbortSignal): AsyncGenerator<AgentEvent, RunOutcome, void>;
}
```

`RunInput` identifies accepted input, session, and execution generation; it does not supply an authoritative mutable message array. The runner accesses committed state and invokes Core's narrow commit operations through injected ports. A `RunOutcome` identifies the committed terminal state: completed, cancelled, blocked, or failed. Yielding an event is never the mechanism that makes its business effect durable.

An async generator provides an interface and backpressure, not automatic scheduling independence. Backend owns and continuously drains the generator. UI subscriptions observe the Backend's broadcast; a slow tab, no open window, or an unsubscribed component never pauses the agent. The pump awaits bounded internal operations, not renderer acknowledgment. Coalesce or drop transient deltas for slow observers and mark them for resynchronization; committed facts remain queryable by cursor.

Interruption is an explicit command that fences the active runner and requests cancellation. A renderer's iterator disposal only ends its subscription. Disposing the internal runner aborts its model/reviewer/summary requests and requests cancellation of foreground jobs, with bounded cleanup in `finally`. Jobs already transferred to session background ownership remain supervised by Core; they do not retain the runner's AbortSignal. Unexpected generator/pump failure is recorded as interruption before recovery, not interpreted as completion.

Only one runner advances a session. A run handles accepted input and its reasoning/action rounds; additional input can steer it at the next reasoning boundary or explicitly wait for the next run. Neither mutates an in-flight request. Different sessions use bounded scheduling. A round is one main Chat attempt followed by its local tool batches, which may return background-job handles. Provider-native tool activity occurs inside the Chat attempt.

### 2.1 User interruption

Distinguish three operations in both commands and UI:

- **Send/steer:** persist input for the next reasoning boundary without aborting a request already in flight. If the session is idle, schedule a run. An explicit next-run placement is also available.
- **Stop:** interrupt the targeted active run, cancel its foreground work, and hold automatic agent continuation. Already-backgrounded jobs continue; the UI names any remaining jobs and provides separate cancellation controls.
- **Stop and cancel jobs:** perform Stop and request cancellation of the session's active jobs as well. Individual jobs also support cancellation independently of the agent.

An `interrupt` command carries an operation ID and expected run ID/generation. In one transaction Core records the interruption, revokes that run's authority to commit context or authorize new effects, sets the session's continuation gate to held, and records cancellation requests for the applicable jobs. A stale command returns the targeted run's outcome; it never interrupts a newer run. After commit, Core signals the model/reviewer/summary and executors. Receipt acknowledgment means interruption was durably accepted, not that every remote operation has stopped.

Dispatch authorization and completion race with interruption through Core transactions. A result committed before Stop remains history; a result arriving afterward may record usage or the actual effect outcome but cannot advance the old run or launch successor work. Already-authorized external work may be in flight; signal checks reduce the dispatch window but cannot make network/OS effects atomic with SQLite. Cancelling does not roll back a completed edit, shell command, or remote request.

Append a run-ending interrupted/cancelled state and a cancellation acknowledgment without waiting indefinitely for external termination. Keep unfinished effect/job cleanup visible as cancelling or outcome-unknown. Complete any committed but unresolved tool-call protocol groups with truthful cancellation, background-handle, or unknown-outcome results before the next model request. Never manufacture success or delete an earlier assistant tool call. Late factual outcomes arrive as new observations, not replacements for already-submitted tool results. Preserve already-published partial model output as an interrupted assistant draft using the protocol below; incomplete does not mean disposable.

Stop leaves pending inbox entries intact but suppresses automatic wakeups, including job completion. An explicit resume or a new user submission releases that gate. An interrupt-and-send operation can atomically fence the old run, enqueue replacement instructions, and authorize a successor run once the old context writer is fenced and protocol cleanup permits it. Old consumed messages remain in history and are not enqueued twice. Following an unexpected crash, recover work under the existing durable gate; explicit user Stop is never undone by restart.

### 2.2 Partial output and continuation after interruption

User-visible generated text is durable before presentation, even while its answer is incomplete. Persist ordered, bounded stream chunks under `(attemptId, itemId, chunkSequence)` and publish only committed ranges to Renderer. Batch small deltas with bounded latency/size; do not require one database transaction per token. Apply backpressure if persistence cannot keep up. Uncommitted provider buffers may be lost, but must not have been displayed as answer content. Spinner/throughput/progress events can remain transient.

A message has one stable identity and a projected lifecycle: streaming, completed, interrupted, or failed. Chunks are immutable records, not separate assistant messages. On success, append a finalization record referencing the chunk ranges and validated provider completion. On Stop, Core's interruption transaction captures the last committed publication position, seals that attempt's visible draft, and enqueues its interruption observation atomically with the run fence. That narrow control operation may finalize existing text; it never grants a stale runner permission to append context or dispatch tools. Buffered/late text beyond the cutoff cannot extend the published draft. Persist later reported usage or factual outcomes separately. On crash, seal the last committed range with a crash reason rather than claiming a user requested interruption.

For a lagging UI, Stop may include a validated `displayedThrough` item/chunk offset for the initiating view. Store that reference separately from the committed/generated cutoff so context can distinguish what was generated from what that view reported displaying. The UI never supplies replacement text. If no display acknowledgment exists, the agent can quote the last published text, but must not claim certainty about the user's exact viewport. These references belong to conversation presentation state; global activity still contains no text.

Before the next reasoning call, append the preserved assistant text and a host interruption observation through the same idempotent inbox/preparation mechanism. The partial answer is not recreated by a model, shortened into a summary, or tagged as successful completion. Use an assistant-text representation when legal for the adapter, followed by a separate host reminder; otherwise use an explicit quoted transcript artifact with assistant provenance. Provider-private reasoning and incomplete tool-call arguments are not promoted into spoken answer text. No truncated function call is executed, and no nonexistent tool result is invented for an uncommitted intent.

For an interrupted visible answer, the next context can contain this reminder after the exact partial assistant text.

```xml
<system-reminder reason="user-interruption" attempt-id="attempt-42" partial-message-id="message-17">
The user interrupted you. Your preceding assistant message is incomplete.
Preserve what you already said; do not assume unfinished actions completed.
</system-reminder>
```

When a tool is interrupted, its original result instead carries `interrupted`, the cause, retained partial output/ranges, and the known execution/effect state. Distinguish cancelled before dispatch, stopped after partial execution, and cancellation requested with unknown outcome. Add a run-level reminder only if it conveys something not already present in those results. For a previously returned background handle, cancellation/completion is a new notification, not a rewritten or duplicate result. If Stop happens during approval or before dispatch, say explicitly that the tool did not execute; if it happens during compaction, report that the previous context remains active unless the compaction commit had already won.

Order continuation as: preserved partial assistant content and required tool outcomes, interruption observation, then the new user message. Source changes and ordinary reminders follow the boundary's normal ordering. Causal dependencies take precedence over simple inbox arrival order, and are persisted rather than inferred from timestamps. Stop-and-send establishes these dependencies atomically. Repeated Stop commands and recovery do not duplicate the partial message or reminder.

Keep the most recent interrupted visible answer verbatim through the first resumed reasoning call, including when compaction is needed. If it cannot fit, preserve a clearly labelled exact tail and a stable transcript reference accessible through `Read`; never silently substitute a paraphrase when the user asks for the last sentence. Older interrupted drafts remain exactly retrievable after later compaction. Tests must verify that a question such as "What was your last sentence?" receives the actual interrupted text, including an unfinished final fragment and any known display cutoff. This provides the evidence for an accurate answer; it does not assume the model remembers text absent from its context.

### 2.3 Agent-visible operation effects

Every command/tool/job design must specify its durable outcome and whether/how that outcome enters model context. A frontend event alone is insufficient for an operation that changes what the agent should do or believe. Core produces bounded, provenance-labelled context observations from committed facts; technical diagnostics stay outside the prompt.

| Operation                                               | Model-visible representation                                                                                                                    |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| User interruption of generation                         | Exact interrupted answer plus causal host reminder and available presentation cutoff                                                            |
| Tool cancellation/failure/partial completion            | Original structured tool result with retained output and truthful effect status; later corrections are new observations                         |
| Background handoff/completion                           | One initial job handle, then a deduplicated terminal/status-change notification                                                                 |
| User steering or task changes                           | New user content or task-revision reminder before the next reasoning call                                                                       |
| Skills, memory, permission or tool-availability changes | Revision notification explaining the current consequence, without changing the frozen prefix; critical revocations also enforce execution gates |
| Compaction                                              | New epoch with summary and coverage provenance, plus a compact status observation where needed; failure preserves the old epoch                 |
| Theme, navigation, repaint, tracing/export diagnostics  | No model context by default; retain only the applicable activity/diagnostic information                                                         |

Do not inject every progress tick or duplicate full event payloads. Required interruption/protocol observations cannot be dropped by optional middleware. Producers enqueue observations transactionally with the outcome when possible, otherwise through a recoverable, deduplicated projection of committed records. Observation delivery never implies successful work or changes a user Stop into permission to resume.

## 3. Records, content, views, and events

Records are immutable business facts. Entries/Blocks represent model-facing content. A context View selects references from records; it is not a second history store. Events announce progress or committed changes to observers. Global activity still stores only operation types and references.

`model.output.chunk` records hold ordered stream content; `model.output.finalized` seals their ranges as completed, interrupted, or failed under one message ID. Presentation acknowledgments reference published positions. Model context renders one message from those ranges, never one message per chunk and never both the draft and a duplicate final copy.

These record families extend the journal described in the application design.

| Record family                                                       | Durable content                                                                                                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `context.epoch.started`                                             | Frozen system content, ordered tool schemas, model/adapter/config revisions, renderer revision, source snapshot references and observation times |
| `context.appended`                                                  | Ordered immutable message/block references and their cause: input, tool result, reminder, source notification, or middleware contribution        |
| `inbox.accepted` / `inbox.consumed` / `reasoning.prepared`          | Immutable input reference and placement; exact per-delivery consumption into a frozen context and call plan, with a boundary watermark           |
| `run.interrupt.requested` / `run.interrupted`                       | Target run/generation, durable continuation gate, cancellation scope, and acknowledged control outcome                                           |
| `source.observed` / `source.removed`                                | Source identity, previous/new revision, content hash or tombstone, observation time and immutable content reference                              |
| `source.delivered`                                                  | Session/epoch, revision transition, notification record, and consumption position                                                                |
| `approval.decided`                                                  | Tool intent, normalized argument digest, policy/reviewer revision, verdict, matched rule or selected suggestions, model-attempt reference        |
| `tool.batch.planned`                                                | Ordered calls, execution groups, resource constraints, original call indexes                                                                     |
| `tool.started` / `tool.finished`                                    | Effect identity, execution state, validated result/error and artifact references                                                                 |
| `job.created` / `job.started` / `job.backgrounded` / `job.finished` | Durable execution identity, ownership and wait policy, output references, terminal facts, and completion-delivery reference                      |
| `job.cancel.requested` / `job.cancel.acknowledged`                  | Requested cancellation versus executor acknowledgment, with actual effect outcome kept separate                                                  |
| `compaction.started` / `compaction.finished`                        | Compaction ID, frozen coverage, summary attempt, success/failure/interruption, retained references, and successor epoch on success               |
| Task, message, model-attempt, state, and usage records              | The existing complete append-only agent state                                                                                                    |

Source revisions may be shared across sessions in the same database; each session records its own delivery. Do not duplicate full content into UI events, activity, or rule records. Permission-rule installation/revocation is versioned Core state; agent records reference the exact revision used.

Events have two explicitly different durability classes.

```ts
type AgentEvent =
    | {
          type: 'committed';
          sessionId: string;
          runId: string;
          recordId: string;
          seq: string;
          recordType: string;
      }
    | {
          type: 'progress';
          sessionId: string;
          runId: string;
          attemptId: string;
          phase: 'model' | 'tool' | 'approval' | 'compaction';
          delta: ProgressDelta;
      };
```

The eventual `ProgressDelta` is a discriminated union, not arbitrary JSON. A committed event is emitted only after its transaction succeeds. User-visible answer chunks are published as committed content references; transient progress does not carry an unpersisted answer. The renderer maps `compaction.started` to an in-progress state and `compaction.finished` to success or failure, with optional transient progress in between. On reconnect it queries the projection and catches up by cursor. A lost completion notification cannot leave the UI permanently compressing. Partial answer/tool content is labelled incomplete, which is independent of whether its bytes are durable.

## 4. Execution sequence

Every round follows this order; local state changes do not require repeating a successful external request.

1. Claim accepted input under the current generation. Restore the context epoch, tasks, and pending effects from the journal.
2. Reconcile configured sources and persist user input, notifications, job completions, and runtime reminders into the durable inbox. At a legal boundary, select a bounded batch using a fixed watermark as described below.
3. Run context-contributing middleware against that candidate view and persist its contributions. Check context budget and compact if needed without acknowledging pending input prematurely. Atomically append the selected context, mark its deliveries consumed, and freeze the exact call plan through `prepareReasoning`.
4. Persist the model attempt, invoke the Chat adapter, and commit user-visible chunks before publication. On complete output, finalize the message references, protocol items, usage, and local tool intents together. Interruption instead seals the draft and stages the appropriate observation. Partial tool arguments never execute.
5. Validate and batch local calls. Core creates and executes approved jobs independently of the runner's wait. A tool call resolves to its final result, a durable background handle, or an explicit failure/cancellation outcome. See Sections 8 and 9.
6. At the batch protocol barrier, append result/handle references in original call order. Actual background effects can still hold resource locks. Stage notifications in the inbox; do not insert them between unresolved tool calls and required results.
7. Return to the pre-reasoning inbox boundary if tools or eligible messages require another round. Otherwise run bounded `beforeFinish` middleware. The final completion transaction checks pending eligible input and the continuation gate again, so a racing message is either handled by this run or schedules a successor, never stranded.

Persist maximum rounds, model-attempt limits, tool timeouts, and continuation limits in run configuration. Exhaustion produces a visible blocked outcome, not an infinite loop or a silent deletion of tools. Initial middleware continuation limit is one per run. Approval and compaction calls have their own attempts, token usage, cancellation, and tracing; they do not recursively invoke the main agent or its tools.

### 4.1 Durable inbox and the consumption boundary

All model-facing additions use one ingress mechanism: user input, steering, source revisions, task/time reminders, background-job completion, middleware contributions, and later cross-session messages. Producers call Core to persist immutable content plus a target delivery before acknowledgment. They never push directly into the runner's mutable message array. In-memory notifications only wake the scheduler.

The delivery contract distinguishes scheduling from context content.

```ts
interface AgentDelivery {
    id: string;
    sessionId: string;
    contentRef: RecordRef;
    source: 'user' | 'source-change' | 'runtime' | 'job' | 'middleware' | 'agent';
    placement: 'next-reasoning' | 'next-run';
    sequence: string;
    deduplicationKey: string;
    wake: 'notify' | 'run';
}
```

The receipt has a stable operation/delivery ID. `wake: run` requests scheduling when the session is eligible; it does not override Stop, start a second runner, or guarantee immediate execution. User input and terminal background-job completion normally request a run. File changes, clock reminders, and progress updates do not independently start endless agent activity. Optional run-scoped contributions carry a target run and an explicit discard/retarget policy when that run ends; they cannot leak into an unrelated run by accident. Output chunks are queryable job data, not an inbox message per chunk.

Immediately before each main reasoning call:

1. Complete required tool-call/result protocol groups and interruption observations, reconcile sources, and read the current generation and context revision. Capture a finite inbox watermark. Select eligible deliveries through that watermark in acceptance order subject to explicit causal dependencies, bounded by count and context budget; next-run entries are excluded from an ongoing run. An atomic interruption/resume group cannot be split to place a new user message before its interrupted draft. Later arrivals remain pending for the next boundary.
2. Prepare a candidate context outside a transaction. Middleware may produce a bounded set of deduplicated child contributions tied to this boundary; persist them and include their exact IDs without extending the external-message watermark indefinitely. Do token estimation and any compaction before final preparation. Newly selected, not-yet-answered user/steering messages remain verbatim in the protected tail, not summarized away before their first reasoning call.
3. Invoke a narrow Core `prepareReasoning` transaction. Validate generation, continuation gate, context revision, and pending selected deliveries; append ordered context-inclusion facts, mark exactly those deliveries consumed, record related source-delivery positions, and store the frozen call plan plus `reasoning.prepared`. Commit all or none. No model/network work occurs inside this transaction.
4. Persist attempt/dispatch intent for the prepared plan and invoke the model, subject to a final ownership check. Record response and actual usage independently of inbox consumption.

**A delivery is consumed when step 3 commits.** It means durably included in a prepared reasoning context, not received by the API, answered, or successfully acted upon. UI/query states distinguish queued, included, and the linked attempt/run outcome. Consumption is per delivery because placement, scope, and budget can create gaps; never advance a cursor past unconsumed entries merely because a higher sequence was processed. Do not skip an oversized user message and process later user instructions as though it never existed: compact, block with a reason, or obtain an explicit cancellation/replacement.

The distinction determines recovery behavior:

| Failure/race                            | Required result                                                                                                        |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Before `prepareReasoning` commits       | Deliveries remain pending; no partial context insertion                                                                |
| After commit, before model dispatch     | Reuse the persisted plan/context under valid recovered ownership; do not insert messages again                         |
| After dispatch, before result commit    | Preserve included input and interrupted/unknown attempt; a permitted retry is a new attempt, never an inbox redelivery |
| Stop wins the preparation race          | Preparation is rejected; deliveries stay pending behind the held gate                                                  |
| Preparation wins, then Stop             | Included messages remain in context; no rollback of consumption; a successor can use that history after resume         |
| A delivery arrives beyond the watermark | The in-flight context is unchanged; consume at a later eligible boundary                                               |

Compaction may absorb source changes into a new epoch baseline, but the next `prepareReasoning` still records which deliveries are represented by that epoch instead of adding duplicate notifications. A failed preparation retries local selection/validation without repeating committed middleware model calls. A failed compaction does not acknowledge pending messages. Execution-work completion acknowledgments remain separate from context-delivery consumption: `completeWork` commits effects/results, while `prepareReasoning` commits the next input selection.

## 5. Prompt cache contract

### 5.1 Context epochs

A context epoch is the interval between session initialization and a successful compaction, or between two successful compactions. Within an epoch, Whim only appends to model-facing history. It never rewrites, removes, reorders, or reserializes an already submitted prefix in response to live filesystem or settings changes.

Freeze the following at epoch creation:

- Exact system instructions and their serialized representation.
- Skill catalog metadata and the file-memory index snapshot, with `observedAt` timestamps and content revisions.
- Ordered tool names, descriptions, schemas, native-tool declarations, and their serialization.
- Model route, prompt-affecting model options, adapter/context-renderer versions, and any verified cache configuration.

Persist rendered prefix artifacts and immutable protocol items, not just a recipe that reads current files. Ordinary requests append new items to this frozen representation. Preserve role, order, tool IDs, provider continuation fields, and content bytes. Do not merge later notifications into earlier user messages. Token accounting and trace IDs live outside prompt content. Timestamps already included in a snapshot never refresh on replay.

Only successful compaction may replace the prefix of an existing session. A model change, tool-schema addition, instruction-template update, or adapter rendering change therefore waits for an explicit compaction boundary. A model switch request remains pending until compaction succeeds; if the old route is unavailable, a separately recorded summary request may use an explicitly selected compatible model. It must not silently reinterpret old provider metadata. Failed compaction leaves the old epoch intact. Initial session creation is the only prefix creation without a prior compaction.

Revocation is immediate even while schemas remain frozen: a disabled local tool returns an unavailable result instead of executing. If an enabled provider-native tool cannot be disabled without changing the request prefix, stop further main calls until compaction installs the revised catalog. Credential refresh alone need not alter the prompt; it must not silently change region/model routing. Existing attachment representations and remote references also remain fixed; an expired reference requires compaction/repreparation rather than rewriting old messages.

This is an application-controlled prefix guarantee, not a guarantee of provider cache hits. Expiry, eviction, model deployment changes, minimum lengths, and unsupported cache modes remain external. Validate the actual route and record reported cached tokens. DashScope Responses session caching uses remote response chaining; Whim's initial `store: false` local-replay route does not rely on it. Prefix preservation remains required even when reported cached tokens are zero. [DashScope context cache](https://help.aliyun.com/zh/model-studio/context-cache), [Responses cache configuration](https://help.aliyun.com/en/model-studio/qwen-api-via-openai-responses).

### 5.2 Runtime instructions

Static instructions explain how to interpret runtime notifications and current revisions. Dynamic information is appended as host-generated content with provenance, rather than changing system-role instructions on every request.

The following reminder is created once at a chosen boundary and persisted verbatim.

```xml
<system-reminder observed-at="2026-11-04T10:00:00+08:00">
Current time: 2026-11-04T10:00:00+08:00.
Task task-7 remains pending: validate the PDF import limit.
</system-reminder>
```

Use current time at user-turn start and when a configured elapsed-time threshold makes another reminder useful; do not prepend a new clock value to every API request. Task changes append their committed revisions. Initial task state is included in a new epoch; later reminders only add useful changes or bounded reminders. These messages use the adapter's legal message representation, initially a separate user-role text item at a completed boundary. Their internal origin remains `host`, not `user`.

XML tags organize content; they are not a security or role boundary. Escape embedded text and preserve source provenance. Skill and memory content cannot grant tool permission by containing a forged tag. The approval engine reads authoritative instructions, grants, and structured effects, not an arbitrary notification as authority.

## 6. Incremental source tracking

Track configured skill directories, `MEMORY.md`, explicitly loaded skill/reference/memory files, and other registered context sources. This is targeted context tracking, not a log of all filesystem activity.

A source revision contains `sourceId`, canonical location, source kind, content hash, byte length, `observedAt`, optional filesystem modification time, and an immutable content reference or tombstone. Observation time is when Whim obtained the bytes; modification time is only a hint. Stable reads and hashing determine change, including atomic-save replacement. An unchanged read creates no new content revision or notification. Deletion followed by recreation is a new revision even if the bytes match; revision identity therefore includes the observed transition, not only the content hash.

Use file watchers as wakeups and reconcile at run start, before the next main request, before executing a newly referenced script, and after restart. Watchers can miss or coalesce writes; Whim promises observed revisions, not every transient edit. Known writes through Whim's file service trigger reconciliation. External writes that happen between checks are observed at the next boundary. Permission errors or unreadable files produce explicit source-unavailable observations, not a false deletion or empty file.

The transition from observation to model delivery is transactional:

1. Snapshot bounded content outside the transaction and detect the new revision; retry a changing read within a bound.
2. Commit immutable content, the observation, and change-index position.
3. Compare observed revisions with that session's delivered/pending revisions and enqueue immutable notification references, deduplicated by session, source, and revision transition.
4. At `prepareReasoning`, commit the context inclusion, inbox consumption, and delivered positions together. Sources selected into a refreshed epoch are referenced through that epoch instead of rendered twice.

A crash before step 4 leaves the change pending; a crash after it cannot inject it twice. During a model call, new observations queue for the next boundary and never alter the in-flight plan. Sessions consume shared revisions independently. Unconsumed source changes may coalesce to their latest revision only with explicit supersession facts linking omitted deliveries to their replacement; never apply this to user input or effect outcomes. A deleted source produces a tombstone. A gap in watcher history is not reported as a complete edit history.

For example, adding a skill appends its new metadata without modifying the old catalog.

```xml
<system-notification source="skills" observed-at="2026-11-04T10:05:00+08:00">
Skill pdf-review was added at revision skill-revision-3 (hash sha256:abc123).
Description: Review PDF reports and compare cited figures.
Location: skills/pdf-review/SKILL.md.
Use the latest announced revision. The initial catalog is an earlier snapshot.
</system-notification>
```

Notifications distinguish added, changed, removed, and unavailable. For an unloaded skill, include current metadata and revision, then load its body on demand. If loaded instructions change, append the bounded replacement or an explicit revision-aware delta. For `MEMORY.md`, append the new bounded index content or an unambiguous change with its previous/new revision. Never silently claim a huge update is fully included: expose omitted detail through immutable references and `Read`, or request compaction. If the bounded source cannot fit even after compaction, keep it unavailable with a visible reason.

The effective source view uses the latest delivered revision, while previous content remains in history. At compaction, select one consistent source snapshot and observation cursor. Refresh system skill metadata and the memory index from that snapshot; append later observations after the new epoch. A retained old notification does not override a newer epoch baseline: revision precedence is explicit in both the context protocol and the fold.

## 7. Context compaction

Compaction is a durable model operation and the only prefix-replacement boundary. It can start automatically before budget exhaustion, through an explicit command, or from a bounded overflow-recovery path.

Context budgeting includes system content, tool declarations, retained protocol items, queued notifications, attachments or tool results, output reserve, and a safety margin. Check before a main call and after tool batches. Byte limits are not token limits. Unknown provider PDF tokenization requires conservative admission or a bounded processed representation; it never justifies sending an unbounded document. A failed/overflowed request may trigger one compact-and-retry attempt, with separate usage accounting.

The compaction coordinator performs the following transaction boundaries:

1. Wait for a legal boundary with no unresolved tool-call protocol group; a job handle can close such a group while the job still runs. Freeze coverage IDs, previous summary, retained tail, task/state revision, background-job references, and source snapshot cursor. Commit `compaction.started`.
2. Build a bounded summary request without modifying the live epoch. Preserve unresolved task facts, user constraints, relevant source revisions, artifact references, and the meaning of tool results. Split into explicit bounded summary passes if required; no hidden oldest-message dropping.
3. Call the configured summarizer with its own attempt and trace. The summary is descriptive memory, not a source of new permissions or task completion.
4. Validate the candidate context against the target model. Atomically commit the summary, exact coverage/retained references, refreshed epoch prefix/tool catalog/source baseline, and `compaction.finished` success.
5. On failure or cancellation, append that outcome and keep the prior epoch. On restart, reconcile an unfinished compaction; a new summary call is a new attempt.

Original records, tasks, usage, and external-effect identities are never deleted. Keep complete tool-call/result groups and required provider protocol fields. Checkpoints remain optional replay caches, not compaction. Do not replay old tools to rebuild a context.

The renderer can show compaction start, summary progress, completion, and failure. It must identify estimated versus reported token counts and display a blocked state if the uncompressible prefix or latest input still cannot fit.

## 8. Tools, batches, and data flow

### 8.1 Tool ownership

The initial local tools are `Bash`, `Grep`, `Edit`, `Write`, `Read`, and `Glob`, plus a bounded `ReadPDF` when its processor is available. `JobStatus`, `JobOutput`, and `JobCancel` let the agent manage long-running work; these schemas are installed at epoch creation even before the first job exists. Available native WebSearch/WebFetch declarations are added automatically only when the exact model route implements them and policy permits the provider's execution boundary.

The tool categories have different execution paths.

| Category                  | Implementation and inputs                                                                                                       | Results and consumer                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `Bash`                    | Core-owned async subprocess; explicit cwd, environment policy, timeout, bounded output                                          | Exit status and bounded output/artifact reference; journal then next model round                                               |
| `Grep`                    | Core-owned `rg` invocation with structured arguments, root scope, output limits; verify packaged macOS binary                   | Matches and truncation/cursor information                                                                                      |
| `Glob`                    | Core file service; scoped patterns and bounded results, no model-authored shell interpolation                                   | Paths, with further access still checked by Read                                                                               |
| `Read`                    | Core file service; bounded ranges from workspace files or immutable snapshots                                                   | Exact content revision and range; snapshot what enters context                                                                 |
| `Edit` / `Write`          | Core file service; expected revision/hash, explicit replacement semantics                                                       | New revision or conflict; file mutation is an external effect                                                                  |
| `ReadPDF`                 | Core document service; artifact ID and page range; extraction/rendering or an explicitly configured provider document operation | Page-labelled text and optional supported image parts, bounded to fit context; never an unsupported PDF in a tool-result field |
| Native WebSearch/WebFetch | Provider executes inside the Chat call; model plugin enables declarations and decodes progress/citations                        | Provider protocol items, citations, final response; no second local execution                                                  |
| Skill / memory content    | Skills via revision-aware Read; memory plugin via Core sources, files, and middleware                                           | Append-only instruction or retrieval contributions                                                                             |

Local tools are independent of a model plugin. Plugins can register concrete extra tool implementations through the same validated interface, but provider-native declarations are not ordinary local `execute()` functions. Model cards describe capability; Core builds the effective catalog; agent schedules local calls; adapters translate requests/events; Core commits outcomes; model and UI consume different views of those facts.

For DashScope Responses, WebFetch maps to `web_extractor`; its documented dependency on `web_search` and thinking requirements are adapter validation rules. Do not enable `code_interpreter` merely because an example recommends it. Native search/extraction can run multiple internal actions before the response ends. Their progress belongs to the model attempt; only returned facts can be persisted, and unavailable raw pages are not fabricated. [Web extraction API](https://help.aliyun.com/zh/model-studio/web-extractor).

Native web activity and local function calls can coexist in a ReAct loop when verified on the chosen route. The adapter preserves native output items and citations for continuation and returns local function-call intents to the runner. Only those local calls enter approval and batch scheduling. If a provider item cannot be replayed through the stateless route, that combination is unavailable until a supported representation is implemented.

PDF input is a media capability, not automatically a callable tool. Attachments are prepared before invocation. `ReadPDF` is an application function for selecting pages and producing supported result content. A provider PDF analysis call may be an explicit child model operation behind that function; it uses its own card, approval for data transfer, attempt, and usage. It does not switch the main conversation model or change its cache prefix. Hosted `file_search` requires a separate knowledge base and is not a PDF attachment reader; it remains outside the one-database initial design. [Hosted file search](https://help.aliyun.com/zh/model-studio/file-search).

### 8.2 Ordered batches

Every local tool defines concurrency metadata and tool-aware access/effect descriptors. Start conservatively: read-only, concurrency-safe calls may share a bounded parallel group; `Bash`, `Edit`, and `Write` are serial barriers. Read-only is not a permission grant or proof of independence. Unknown tool behavior is serial.

Preserve original call order while forming contiguous groups. For example, `[Read A, Grep B, Edit A, Read A, Glob C]` becomes `[Read A || Grep B] -> [Edit A] -> [Read A || Glob C]`. Groups execute serially; calls within a parallel group use a semaphore, initially four slots. Explicit dependencies or conflicting resource accesses force separate groups. Do not reorder a read across a write to improve throughput.

Core arbitrates canonical workspace resources across sessions too; a per-session serial barrier cannot prevent another session changing the same file. Begin with a workspace-wide barrier for Bash and mutations, shared read access for declared read tools, and expected-hash checks for external edits. Acquire execution locks after approval, then revalidate targets/policy before dispatch; never hold them while waiting for a review model. These locks coordinate Whim's work, not other applications. More granular locks require demonstrated need.

Persist each outcome as it completes so a crash does not erase successful parallel work. The context appends result or background-handle references in original call order once the protocol group is resolved. UI completion order may differ from context order. A background handle closes the model call, not the resource/dependency barrier: conflicting or dependent jobs remain queued until the actual effect resolves. Failure produces a typed tool result; cancellation stops unstarted calls and reconciles dispatched effects. An unknown mutation outcome blocks dependent groups instead of pretending failure means no effect. A restarted runner never reexecutes a committed tool result.

Do not let a later non-backgroundable call make handoff ineffective by waiting indefinitely behind the background job. Resolve that unstarted call with a deferred/not-executed result naming the blocking job, then return control to reasoning. The agent can inspect the job and issue a fresh call later. A background-capable dependent job may instead return its own queued handle, preserving dependencies and revalidating approval/preconditions when execution actually begins.

Bound stdout/stderr, result size, runtime, and process lifetime. Truncate or offload results before their first context insertion and expose exact range/artifact references. Once inserted, do not shorten older results except through compaction. Grep/Glob use structured arguments; shell strings remain confined to Bash.

### 8.3 Independent job execution and background handoff

Core owns tool execution from the start. The agent submits an approved intent and waits for a result; it does not own the subprocess or execution promise. Each local invocation has a stable `jobId`, original `toolCallId`, effect ID, session, origin run, arguments/approval revision, executor generation, resource claims, deadlines, and output references. A Job is an execution record, distinct from the agent's planning Task.

Backgrounding changes waiting and ownership, not the execution itself. Do not start the command again or migrate a live promise to another thread. Keep execution state (`queued`, `running`, `succeeded`, `failed`, `cancelled`, `interrupted`, `unknown`) separate from wait mode (`foreground`, `background`) and cancellation requests. An old run being fenced does not invalidate outcomes reported by a still-authorized background executor; only that executor's own generation may commit job outcomes.

A tool declares whether background handoff is supported and whether cancellation/reconciliation is available. Initial Bash supports it; bounded PDF processing can use it while retaining its parse deadline. Small Read/Edit/Write operations remain foreground initially. Provider-native actions inside a Chat request cannot be individually detached; they remain part of that request. Unsupported tools are never made background-capable by a timer alone.

Use these initial scheduling defaults, versioned outside the frozen prompt:

- Foreground wait budget: 10 seconds for eligible jobs, including queue time. This is not the execution timeout.
- An explicit user request or supported tool option may request immediate background mode. User interruption is a different action and never silently converts a foreground job into background work.
- Retain each tool's approved absolute execution deadline and output/resource caps after handoff. Backgrounding grants neither unlimited runtime nor broader effects. Default Bash execution deadline is 5 minutes; a longer job must request a bounded extension under policy.
- Bound active jobs per session and application; pending jobs remain durable. A queued job is described as queued, not running. No unbounded polling or task creation to escape resource locks.

At the wait deadline, completion and handoff compete through one atomic state check. If the job already finished, return its final result. Otherwise commit `job.backgrounded`, session ownership, and exactly one original tool response containing `{ status: 'queued' | 'running', jobId }`, with instructions for inspecting output or cancelling. The runner may continue after its protocol group closes. If Stop wins before handoff, cancel the foreground job; if handoff wins first, the job follows the already-backgrounded policy. A crash between committing the handle and displaying it reconstructs the handle from the journal without redispatch.

When a background job finishes, commit its outcome, output references, and a deduplicated completion delivery in one transaction. The agent receives that notification at the next reasoning boundary; an idle eligible session may get one successor run. A stopped session only shows the UI notification until resumed. The final outcome is a new notification, never a second function result for the original `toolCallId` and never an edit of its earlier handle. Compaction retains active job references and later delivery positions so handles remain usable.

The management tools share Core services with UI controls:

| Tool        | Contract                                                                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `JobStatus` | Query one job or paginate session jobs; report execution state, wait mode, cancellation state, retained output cursor, and actual outcome     |
| `JobOutput` | Read bounded committed output from a cursor; expose truncation/gaps, next cursor, and artifact references; no unbounded wait                  |
| `JobCancel` | Persist an idempotent cancellation request under authorized scope; return a receipt and observed state, not an invented terminal cancellation |

Model-visible tool outputs are snapshotted when inserted into context. Output chunks use ordered sequence IDs, bounded buffering, and durable commits to SQLite; publish retained output only after commit so output already shown remains retrievable. Unpublished buffers may be lost on crash. After the configured retention cap, mark truncation and drain/discard or terminate according to the tool policy so pipes and memory cannot grow indefinitely; discarded bytes must not appear as retained transcript content. Durable output queries do not treat transient UI buffers as authority. Completion does not erase logs or remove consumed inbox bodies.

Executor placement follows workload, not foreground/background mode. Native async filesystem/network tools can remain in Backend under Core's executor scope. Bash and ripgrep already run as child processes; PDF uses its helper process; CPU-intensive JavaScript uses a bounded worker pool when needed. Do not allocate one worker per I/O call or move every tool into a separate process solely for background support. This follows Node's separation of async child-process execution and CPU-oriented workers. [Child processes](https://nodejs.org/api/child_process.html), [worker threads](https://nodejs.org/api/worker_threads.html).

Cancellation stops queued jobs before dispatch, signals running operations, and escalates owned subprocess termination after a bounded grace period. For Bash, manage the owned process group and confirm termination/output closure where possible; killing a shell PID alone is not proof all descendants stopped. A kill request, OS process exit, and side-effect rollback are different facts. Record actual exit and effect uncertainty; escaped descendants or remote work require reconciliation. Never signal a stale/reused PID without verifying process ownership.

The first version supports background work across page changes, reasoning rounds, compaction, and ordinary run completion, not guaranteed survival of application exit or Backend failure. On explicit exit, stop admission and cancel/drain jobs before storage closes. After a crash, reconcile executor ownership and persisted effects; missing handles/PIDs do not prove either completion or no effect. Mark interruption/unknown as appropriate, terminate verified orphaned work where possible, and only retry with explicit idempotency/reconciliation support. SQLite can recover intent and output, not resurrect an arbitrary process. No separate daemon, broker, or job database is introduced.

## 9. Automatic tool approval

There is one normal mode: `auto`. Deterministic policy and reusable rules run first, then an independent model reviewer when needed. Deny and blocked/indeterminate are outcomes, not additional user-selectable modes. An unavailable reviewer never becomes implicit approval.

Two reviewer implementations share this application-level contract while keeping their model protocols separate.

```ts
interface ToolReviewer {
    review(input: ReviewInput, signal: AbortSignal): Promise<ReviewDecision>;
}

type ReviewDecision =
    | { verdict: 'allow'; suggestedRuleIds: readonly string[]; reason: string }
    | { verdict: 'deny'; reason: string }
    | { verdict: 'indeterminate'; reason: string };
```

- **Decision reviewer:** uses the DashScope TypeSafe/System One-compatible Decision adapter. A `choice` question selects allow/deny/indeterminate; separate bounded questions select preconstructed rule candidates. A configurable policy maps returned probabilities to outcomes; confidence is not assumed calibrated. It does not need free-form JSON generation. The reason can identify the selected outcome and relevant policy rather than inventing model rationale.
- **Structured Chat reviewer:** uses a Chat card with verified structured output, validates the returned schema, and enforces that route's thinking/streaming constraints. First use DashScope; the interface also accommodates an OpenAI implementation later without adding an OpenAI provider now.

The Decision model and structured Chat model are different model implementations. Sharing the review result does not turn one into the other. Review requests contain user intent references, normalized tool arguments, scope/effects, relevant policy, and tool-generated candidate rules. Treat tool output, memory, and skill text as contextual data, not permission authority. Review calls have no executable tools, cannot approve themselves, and are accounted/traced separately.

Approval follows a fixed sequence:

1. Validate the call schema and resolve canonical targets, effects, and preconditions through the tool's policy implementation.
2. Apply explicit denies, scope boundaries, revocations, and required constraints. Reusable allows cannot override them.
3. Match active allow rules with the tool's matcher. A match skips the model reviewer but not validation or effect checks.
4. If no rule matches, invoke the configured reviewer. It may allow this invocation and select candidate rules generated for this tool; malformed, timed-out, or uncertain results block the call with a reason.
5. Validate selected candidates against auto-install policy. Persist the verdict and eligible rules atomically. Default reusable grants are session-scoped and bounded; broader workspace/persistent grants require an explicit configured grant policy, not a model silently broadening scope.
6. Immediately before dispatch, check that arguments, generation, target preconditions, and policy revision still match. A changed call must be reviewed again. Persist dispatch intent, then execute.

Tools supply `describeEffects`, `suggestRules`, and `matchesRule` semantics as part of their implementation. A candidate contains tool identity/version, action, canonical resource scope, argument constraints, session/workspace scope, and expiry/revocation information. The model selects valid candidates, not executable predicates or arbitrary broad glob strings. Exact-operation rules are the default when generalization cannot be justified.

For Bash, approval covers the complete command, cwd, relevant environment and executable/script identity. A string prefix such as `git` must not authorize arbitrary shell operators, substitutions, redirects, or a changed script. If a command cannot be decomposed reliably, use an exact normalized command rule or review again. File rules distinguish read from write and recheck paths/symlinks and expected revisions. A previously allowed read never authorizes an edit.

Within a group, approval resolution runs in original call order so a committed rule can cover later matching calls before concurrent execution starts. All calls still revalidate at dispatch. Rule revisions and matched IDs are durable; revocation is effective for not-yet-dispatched calls. Rule matching is not proof that an external effect already succeeded and never replaces idempotency handling.

Provider-native tools execute remotely before Whim can approve each internal action. Review their enablement, data scope, and supported restrictions before sending the model request. If a policy requires per-action URL review that the native API cannot expose, leave the capability disabled and use a separately implemented local tool if available. Never label post-hoc provider progress as pre-execution approval.

## 10. Skills and file memory

### 10.1 Skills

A skill is a configured directory with `SKILL.md`, metadata, and optional references/scripts. Parse bounded metadata, resolve names deterministically, and report conflicts. The epoch system snapshot contains name, description, logical location, revision, and `observedAt`; full instructions load only when selected by the agent or explicitly invoked by the user.

Load through revision-aware Read so the exact instruction body is journaled once and referenced thereafter. Scripts run only through normal approved tools. Skills cannot add executable privileges via frontmatter, replace the approval engine, or install new model tool schemas mid-epoch. New/changed/deleted skill metadata arrives through Section 6's notifications. A changed loaded body is appended as a revision update, not substituted into the old message.

Reads and execution use current observed revisions. If a script or referenced instruction changed after a call was planned, pause that call, observe the revision, and reassess at the next legal boundary. Filesystem races cannot be solved by prompt text alone; tools retain their own precondition checks.

### 10.2 File-memory plugin

The initial `plugin-memory` uses a user-selected memory directory with `MEMORY.md` as its bounded index and separate detail files. It contributes epoch snapshot content and append-only retrieval/update messages through the same source tracker and middleware contracts. It needs no vector database and cannot mutate the system prefix between compactions.

Memory files are editable working sources. SQLite owns the immutable observed snapshots and revisions actually consumed by sessions. A manual or agent edit becomes effective through observation and appended delivery, not through an unrecorded read of the latest file during prompt construction. Detail retrieval returns bounded content with source/revision references. Hash and snapshot the exact bytes used.

Agentic memory behavior can propose additions or corrections after a turn or before compaction. It may use an independently accounted model call, then request normal Core file edits with expected revisions and tool approval. Conflicts with a manual edit are visible conflicts; no blind last-writer overwrite. The write, observation, and future delivery follow the same external-effect and source-tracking boundaries. Memory changes do not become durable just because a middleware yielded an event.

At epoch refresh, the latest consistent `MEMORY.md` snapshot replaces the old index in the new system prefix. Old snapshots remain in the journal. Source deletion means stop using that source in future reasoning; permanent erasure of historical content is a separate explicit maintenance operation and is not simulated by cache-preserving notifications.

## 11. Middleware and agentic middleware

Middleware extends selected lifecycle points through typed contributions. It receives immutable views and scoped services; it cannot mutate the journal, bypass approval, directly call an unaccounted model, or replace an already submitted prefix.

Use a small hook surface with explicit ownership.

| Hook                             | Allowed contribution                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| `buildEpoch`                     | Static instruction/source contributions at initialization or successful compaction only       |
| `beforeModel`                    | Bounded appended messages or a compaction request before the plan is frozen                   |
| `beforeTool`                     | Additional validation or a deny; an argument change creates a new intent and repeats approval |
| `afterTool`                      | Observations and bounded follow-up context; cannot rewrite an already committed result        |
| `beforeCompact` / `afterCompact` | Summary guidance and observation of the committed outcome; cannot silently replace state      |
| `beforeFinish`                   | A bounded appended continuation, such as a task check or memory update proposal               |
| `onEvent`                        | Observation for UI integrations or diagnostics; cannot swallow terminal business state        |

An agentic middleware uses the same hooks but may perform a model-backed bounded decision or generate a contribution. It is not a second unrestricted ReAct loop. Calls go through the model service with their own attempt IDs and tracing. The order, identity, configuration, and contribution IDs are stable for the run; durable per-session state belongs in the journal, not a shared mutable middleware instance.

For background work, `afterTool` runs once when the original call resolves to a handle. Later job completion is a separate committed event and inbox contribution, not a second invocation of the original tool hook. Each middleware context contribution enters the durable inbox and is consumed through `prepareReasoning`; hooks cannot append directly behind an in-flight request.

Core commits contributions before they enter context and records each hook's completed invocation. Recovery reuses a committed contribution instead of calling its model again. Middleware failure is explicit; optional observation hooks may fail without changing committed behavior, while required context or approval hooks block. Mandatory persistence, approval, resource checks, and prefix validation are enforced outside the optional hook chain.

## 12. Verification gates

The agent-first implementation must demonstrate these behaviors before live-model or UI polish can count as completion.

1. Async generator lifecycle: Backend consumption, no-UI progress, slow-subscriber resync, abort/finally cleanup, and one runner per session.
2. Journal replay: complete state/tasks/context reconstruction, exactly-once contribution delivery, independent source cursors, and deterministic tool-result ordering.
3. Prefix invariance: capture successive adapter-visible requests and assert identical previously submitted items, system prefix, and ordered tool declarations until compaction. Exercise time changes, task updates, skill add/edit/delete, memory edits, middleware, and restart.
4. Compaction: successful atomic epoch replacement; failure/cancellation leaves the old prefix; changes during summary delivery appear afterward; no broken tool groups; retained old notifications cannot override newer snapshots.
5. Approval: both reviewer implementations, schema failures, uncertainty, candidate-rule validation, repeat-call reuse, policy revocation, changed paths/scripts/arguments, and no model calls on valid rule hits.
6. Tools: bounded parallel groups separated by write barriers, cross-session contention, stable context ordering, partial failures, unknown effects, and real process cancellation/recovery.
7. Attachments: byte/page/output/request limits, malformed/encrypted/scanned PDFs, parser timeout/process death, no oversized IPC payload, and a failed attachment that does not corrupt the session.
8. Provider boundary: native tools are not executed twice; required capability combinations are validated; unsupported tool-result media is rejected; observed provider items survive replay or the route stays disabled.
9. Tracing and usage: separate main/reviewer/summary/memory attempts, no content in default traces, known usage retained after cancellation, no fabricated cache hits or complete usage after a crash.
10. Interruption: Stop during model streaming, approval, tool dispatch, and compaction; stale Stop targets; result/Stop races; held continuation across restart; foreground cancellation versus background survival; late effects do not revive the run.
11. Background jobs: completion/handoff races, exactly one original tool response, persisted output cursors/caps, deferred dependencies, management tools, cancellation acknowledgment, process-group cleanup, and no blind redispatch after executor loss.
12. Inbox consumption: arrivals before/after the boundary watermark, next-run gaps, finite batching, atomic context/consumption/plan commits, crashes on either side of that transaction, failed compaction with pending input, and idle/completion wakeup races.
13. Interrupted transcript: commit-before-display chunks, exact reconstruction and finalization without duplicate messages, Stop/chunk races and late output, lagging renderer display cursors, partial tool output, incomplete function arguments, and causal ordering before resumed input. Verify exact last-sentence/fragment evidence before and after compaction, and operation-to-context coverage for agent-relevant state changes.

First prove orchestration with deterministic adapters and real temporary SQLite. Then verify the selected DashScope account/model/region, including a PDF with unique content whose successful retrieval establishes actual ingestion. HTTP success alone is not sufficient. Keep all UI states and notices available in English and Simplified Chinese.

## 13. Asynchronous memory retrieval

The memory plugin must support both explicit agent retrieval and automatic asynchronous retrieval. At an accepted user turn, commit a retrieval intent keyed by session, triggering delivery, query revision, and source snapshot. A bounded session-owned task runs alongside reasoning; it must not delay the first model request. The plugin selects relevant memories; Core owns scheduling, immutable source snapshots, result storage, and delivery. Model-backed retrieval has its own attempt, token usage, cancellation, and tracing.

Commit completion and its inbox delivery atomically. At the next `prepare` boundary, consume eligible completed retrievals with the other inputs and append a bounded host notification containing provenance, query identity, source revisions, observation time, and retrieved content or offload references. Never modify an in-flight request or the frozen system prefix. Source changes do not silently rewrite a previously delivered retrieval.

A result arriving after the run ends remains pending for the next run by default; it must not start an unsolicited answer. Stop cancels unfinished retrievals owned by that turn and holds automatic continuation. Late results are recorded but are not automatically delivered for a cancelled or superseded query. Completion and Stop compete transactionally. A newer user query invalidates undelivered older-query results by default; retain their audit facts and allow explicit retrieval. Compaction preserves pending delivery identities and does not duplicate already consumed results.

Persist intent, completion/failure/cancellation, and delivery acknowledgment independently. Restart reconciles unfinished retrievals rather than assuming an in-memory task survived. Retry uses a new model attempt under the same retrieval identity; only one eligible delivery may be accepted. Bound concurrency, timeout, result size, and automatic retrieval frequency. Empty results produce no model-facing noise. Tests must cover completion before/after reasoning, completion after run end, Stop races, supersession, restart, and prefix stability.

## 14. Tool effects and execution environment

Initial tools run on the desktop without a sandbox. Each tool descriptor declares filesystem access (`none`, `read`, `write`, `read-write`, or `arbitrary`), process execution, network access, and required environment capabilities. Invocation planning resolves resource targets from validated arguments before approval. Unknown effects are not classified as no effects.

Read, Grep, Glob, and ReadPDF declare filesystem reads; Write and Edit declare writes and any reads needed for revision checks. Bash declares arbitrary filesystem access, process execution, and potential network access: a shell command cannot safely be classified as read-only from its name. Web tools declare network access; durable artifact storage performed by Core is separate from direct workspace access by the tool.

Core owns file/resource operations and the execution-environment port. The initial desktop implementation uses native asynchronous files and subprocesses. Tool logic receives that port rather than inventing private path mapping, process ownership, or file storage. A future sandbox adapter may map logical workspace/artifact references to another environment. Do not implement speculative sandbox backends now. These declarations support routing, approval, and observability; they are not a security boundary or proof of sandbox portability.

## 15. Context offload

Offload is required for large attachments, tool results, and retained context made available after compaction. Core owns the artifact lifecycle, immutable disk files, hashes, media types, provenance, range reads, and search. Agent owns context budgeting and chooses a bounded preview before first insertion. Model adapters serialize the resulting bounded entries; plugins do not maintain private offload directories.

Keep offloaded source bytes in immutable managed files under the application's `offload/<session-id>/<artifact-id>/` directory, outside the mutable workspace and memory directory. SQLite is authoritative for model context: the bounded preview, artifact reference, and exact ranges later read into context. Unread offloaded bytes need not be copied into SQLite. Context records reference artifact IDs and content hashes, not machine-specific absolute paths.

Stream ingestion into a bounded temporary file, flush it, and atomically rename it to its immutable destination before committing metadata and the context pointer. A crash before database commit may leave an orphan file; reconciliation can collect it after a grace period. A missing or hash-mismatched referenced file is an explicit unavailable artifact, never an empty success. Persist the exact Read result before exposing it to context; replay must not reread a mutable or missing source to reconstruct previously consumed text. Native binary content submitted directly to a model is consumed content and must also have a durable replay snapshot; it is not classified as unread offload.

Preserve the complete admitted original, not only the omitted suffix, so ranges remain meaningful. Context contains a bounded preview, original size, retained ranges, explicit omitted ranges, media type, artifact identity, and instructions for bounded Read/Grep access. Offload reads are themselves budgeted to avoid reinserting the full oversized content. Binary attachments retain their originals; text previews reference a separately identified extracted representation with page/line provenance. Never byte-truncate a PDF and pretend it remains valid.

Separate inline-context budgets from artifact retention quotas. Inputs above the ingestion quota are rejected before acceptance; output beyond the retention quota is explicitly marked discarded and follows the tool's drain-or-terminate policy. Do not claim discarded data can be retrieved. Once content is submitted to a model, replacing it with a shorter pointer must wait for compaction; initial offload and later bounded retrieval append normally. Protected interrupted answers remain verbatim through the existing retention rules.

Artifacts referenced by journal records or future fork prefixes remain retained. Managed offload files are retained content, not disposable caches. Back up SQLite and referenced offload files as a coordinated manifest. Verify missing-file detection, streamed limits, hash/range integrity, unavailable files, oversized retrieval results, compaction references, and atomic publication under process failure.
