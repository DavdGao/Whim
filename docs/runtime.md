# Headless Agent Runtime

This is the first executable increment, not the complete desktop application. It supports injected text models, durable conversation state, interruption, task revisions, and explicit compaction. The full target remains in [agent.md](agent.md) and [design.md](design.md).

## Package boundaries

The initial three packages have real ESM builds, declarations, type checks, and tests. They share version `0.1.0`.

| Package                 | Implemented responsibility                                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@whimkit/models`       | Runtime-validated Chat cards, concrete MIME routes and limits, text entries, stream events, reported token usage, and the `ChatAdapter` interface     |
| `@whimkit/core`         | Validated command and journal schemas, deterministic context/task projections, and transition validation                                              |
| `@whimkit/core/runtime` | `SqliteStore`, with all synchronous SQLite operations in its owned worker thread                                                                      |
| `@whimkit/agent`        | Async-generator execution, finite inbox selection, model admission, streamed commits, interruption, compaction, and OpenTelemetry API instrumentation |

No Electron dependency or provider SDK is needed for this increment. `better-sqlite3` provides SQLite transactions in the worker, Zod validates persistence and worker boundaries, and the OpenTelemetry API provides optional instrumentation. SDK/exporter packages are test dependencies only.

## Execute and verify

Use Node 24 or later and the repository's pinned pnpm version. Native SQLite must finish installation before running the checks.

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` runs formatting, lint, package builds, type checks, and the actual Node test suites. Package tests import their built ESM output; run `pnpm build` before a standalone `pnpm test` after source edits. Tests use real temporary SQLite databases, deterministic injected adapters, and a real subprocess killed with `SIGKILL`. They do not make provider requests or validate Electron packaging.

## Application integration

The host owns a `SqliteStore` and an `Agent`. Supply a `ChatAdapter` with a validated card, a local token estimator, and a cancellable `generate(request, signal)` async iterable. The estimator returns an estimate, never reported model usage. The adapter must honor cancellation, close resources on iterator disposal, and emit one explicit `completed` event with whatever usage fields the provider actually reported. EOF without that event is failure. Retries belong to the runtime; adapters must not retry secretly. This increment performs no automatic model retries.

The following TypeScript host function accepts an already configured adapter and a new database path. Its consumer is a backend task; a page should subscribe to committed state rather than own this iterator.

```ts
import { randomUUID } from 'node:crypto';

import { Agent } from '@whimkit/agent';
import { SqliteStore } from '@whimkit/core/runtime';

import type { ChatAdapter } from '@whimkit/models';

export async function converse(path: string, adapter: ChatAdapter): Promise<void> {
    const store = await SqliteStore.open(path);
    const sessionId = randomUUID();
    try {
        await store.execute({
            type: 'create',
            sessionId,
            operationId: randomUUID(),
            epoch: {
                id: randomUUID(),
                system: 'You are the Whim assistant.',
                card: adapter.card,
            },
        });
        await store.execute({
            type: 'enqueue',
            sessionId,
            operationId: randomUUID(),
            delivery: {
                id: randomUUID(),
                source: 'user',
                placement: 'next-reasoning',
                entry: {
                    id: randomUUID(),
                    role: 'user',
                    origin: 'user',
                    blocks: [{ type: 'text', text: 'Hello.' }],
                },
            },
        });
        const agent = new Agent(store, adapter);
        for await (const record of agent.run(sessionId)) {
            // Replace stdout with the host's committed-record subscription transport.
            if (record.fact.type === 'output.chunk') process.stdout.write(record.fact.text);
        }
    } finally {
        await store.close();
    }
}
```

`Agent.run()` starts when its iterator is consumed. The host must drain it independently of UI navigation. Closing the iterator interrupts that run; dropping a UI subscription must not close the backend iterator. Read the journal again after reconnecting or after an iterator throws: the generator is an incremental observation surface, and durable error finalization may already have committed.

Call `agent.interrupt(sessionId)` on the owning agent instance to commit a Stop and abort its in-process request. Pass an `AbortSignal` to `run` for owner cancellation. Runs have a configurable `timeoutMs` (default 120 seconds) and at most 32 reasoning steps. Iterator cleanup waits at most one second for the adapter. These bounds do not terminate uncooperative JavaScript or roll back remote requests; adapter cooperation remains required.

An explicit Stop holds automatic continuation. Enqueuing a user message, or committing `resume`, releases the gate. Non-user notifications do not release it. The host still explicitly starts the next run: no desktop scheduler or automatic wakeup service is implemented yet. Direct journal commands are trusted host APIs, not renderer-accessible business endpoints.

## Persistence and context

SQLite schema version 1 contains an append-only journal and command receipts. A receipt stores the canonical command's SHA-256 digest and original record IDs, not a duplicate content body. Retrying the same operation ID and input returns its original records; different input conflicts. Each record has a UUID, session ID, schema version, timestamp, operation ID, and decimal-string session sequence. SQLite orders sequences as 64-bit integers.

Commands are evaluated against the current replayed view inside one immediate transaction. The first implementation rebuilds projections from the journal rather than maintaining a second mutable representation. The worker queue is bounded; opening the store does not claim that any previous runner is dead. The application supervisor may submit `recover` only after establishing that prior execution has stopped. Recovery seals the committed partial output with a crash reason and revokes the old generation. It does not replay a model request automatically.

The following boundaries are implemented and tested.

- `enqueue` accepts content into a durable inbox without changing model context. `next-run` deliveries accepted during a run wait for a later run; eligible `next-reasoning` deliveries can pass them without losing their positions.
- `prepare` atomically consumes an ordered finite batch and freezes its request. New inbox arrivals do not invalidate that request. The system and card remain unchanged until successful compaction.
- `attempt` records model execution intent. Each `chunk` commits before being yielded. `finishAttempt` references the saved chunks through the attempt identity; the assistant message is reconstructed once, rather than storing a second copy of its text.
- Stop atomically seals the last committed chunks, appends an interruption observation, and ends run ownership. Late writes from that generation are rejected. A resumed context contains the exact partial assistant message and host reminder before newly consumed input. This is a publication cutoff; renderer display acknowledgments are not implemented.
- Task commands append a revision and a durable notification together. Task state is replayed separately from conversation summaries.
- Compaction records a frozen summary request and uses a separately accounted attempt. The candidate system, summary, and retained suffix must pass admission before the epoch changes. Failure preserves the old epoch and messages, and a successfully generated but rejected summary still retains its usage. Interrupted text and its reminders remain protected until a subsequent Chat attempt completes.

A model card must provide known context and output token limits for admission. A request reserves the output allowance, applies the text route's byte limit, and applies the request byte limit; unknown byte limits use local bounds of 1 MiB for text and 2 MiB for the normalized request. Individual stream chunks are limited to 16,384 JavaScript string units and an attempt to 1,048,576 units. A provider adapter must additionally enforce the size of its actual encoded wire request and normalize larger transport chunks. There is no automatic truncation, automatic compaction, model switching, or attachment processing in this increment.

Compaction uses the same injected model and card. A new system snapshot can be installed at that boundary; switching model adapters and source snapshot assembly remain later integrations. The current context format only accepts text entries. A PDF route in a card alone does not enable PDF submission.

## Observability and remaining work

The runtime emits `agent.run`, `agent.compaction`, `model.attempt`, and `agent.commit` spans. Commit spans cover the asynchronous database call, including worker turnaround; this increment does not install a tracing SDK in the worker. Explicit parent contexts preserve model and commit relationships across generator suspension without making consumer code inherit those spans. Attributes contain operation and model/session identifiers, not prompts, text, tasks, or raw errors. Tests verify parentage and content exclusion with an in-memory exporter; all other runtime tests run without an installed exporter. Desktop will own SDK/exporter configuration and IPC propagation.

Reported token fields belong to each attempt; absent fields remain unknown. There is no monetary accounting. An interrupted or crashed request may never provide final usage, and the runtime does not invent it. There is not yet a late-usage reporting adapter or an aggregate usage query.

The remaining agent work includes tool-call blocks and protocol groups, local tools, approval/reviewer implementations, job scheduling and background handoff, source revision tracking, skills and file memory, middleware, automatic compaction, durable retry policy, and a backend scheduler. Decision models, live DashScope transports, PDF ingestion, artifacts, activity indexing, fork commands, plugin loading, and Electron UI also remain planned. No live-model or Electron integration result is claimed by the headless tests.
