# Application Errors and Retry State

Status: required design; provider normalization and automatic retries are not implemented by the current text runtime. Existing `StoreError` codes describe local transition rejection only.

Core owns the application failure schema and its public browser-safe export. Provider plugins map their documented error codes, HTTP status, and transport evidence into that schema; application code and UI do not branch on provider names or raw messages. The independent models package need not import the Core runtime. Preserve the native cause in process for debugging, but only persist an allowlisted, content-free failure representation.

## Failure contract

A failure contains a stable `errorId`, category, operation/attempt references, a translation key, safe parameters, optional provider code/status/request ID, and an explicit external outcome (`not-started`, `rejected`, `partial`, or `unknown`). Retry disposition is a discriminated union: `never`, `after-change` with a required action, `backoff` with an optional server minimum delay, or `reconcile` with the effect/operation identity. A boolean `retryable` alone cannot express these distinctions. Unknown server details remain unknown.

The following categories determine application behavior; concrete provider mappings require verified fixtures and documentation when the adapter is implemented.

| Category                             | Default response                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| `rate-limited`                       | Bounded backoff if replay is safe; respect validated Retry-After             |
| `quota-exhausted`                    | Wait for account/configuration change; do not spin on a 429                  |
| `unavailable`                        | Bounded backoff for a safely replayable temporary failure                    |
| `timeout` / `transport`              | Retry only when non-dispatch is known or replay is safe; otherwise reconcile |
| `authentication` / `permission`      | Require credential or permission correction                                  |
| `invalid-input` / `unsupported`      | Reject; show the configuration/input action needed                           |
| `context-limit`                      | Explicit bounded compaction/replanning, not identical-request retry          |
| `content-policy`                     | Explain the rejection without an automatic evasion retry                     |
| `cancelled`                          | Stop; user cancellation never initiates automatic retry                      |
| `conflict` / `stale-execution`       | Reload or relinquish ownership; do not repeat the remote effect              |
| `not-found` / `artifact-unavailable` | Report the missing resource and possible recovery action                     |
| `storage` / `internal` / `unknown`   | Fail explicitly; do not assume transient or retry-safe                       |

An HTTP code is evidence, not the entire classification. A 429 may represent temporary throttling or an exhausted quota. A 5xx or lost connection can occur after execution. A malformed successful response is a protocol failure, not fabricated model completion. Database response loss is resolved by the original operation ID; it must not generate a fresh command ID and duplicate the effect.

## Runtime policy

Before retry, combine the normalized failure with cancellation, run generation, publication state, effect idempotency, attempt count, and remaining deadline. Use bounded exponential backoff with jitter and a validated server minimum delay. Persist the selected delay and due time; if it exceeds the remaining budget, stop or surface a blocked state. No hidden SDK retries are allowed. The initial default is at most three actual attempts per logical request, including the first; adapters cannot increase this budget.

Every actual dispatch gets a new attempt ID and separate usage. Never double-consume inbox input. A pre-publication transient model failure may retry the same frozen request only if its native operations are known replay-safe. Once partial text is published, seal it truthfully and require an explicit continuation/replan; do not silently regenerate and concatenate it. An unknown external-effect outcome requires reconciliation or a supported idempotency key before retry. Model usage that was never received stays unknown.

## Durable UI observations

Append `attempt.failed`, `retry.scheduled`, `retry.started`, `retry.cancelled`, and terminal run failure/blocked facts as applicable. Commit failure and retry scheduling together. Each carries session/run/attempt identity and journal sequence; retry scheduling includes the normalized failure, next attempt number, maximum attempts, and `retryAt`. The later attempt references the scheduling record. User Stop invalidates scheduled retries through the run fence, including after restart.

The host transports committed records through its existing subscription mechanism. The frontend queries a snapshot plus cursor on reconnect and deduplicates catch-up records; transient timers and toast delivery are not authoritative state. Reconstruct waiting, running, blocked, cancelled, and failed states from the journal.

Show a retry countdown, attempt count, and Stop action while waiting. Explain terminal failures using en/zh-CN translation keys and appropriate actions such as edit input, change credentials, or explicitly retry. Distinguish remote success with unknown local acknowledgment from confirmed failure. Do not expose credentials, raw responses, prompts, or provider stack traces. A technical retry countdown belongs in UI, not as repetitive messages in model context; terminal or partial outcomes affecting reasoning receive one durable context observation.

Tests must cover rate limits versus quota errors, Retry-After, exhausted retry budgets, cancellation during waiting, restart before/after the due time, stale generation, partial stream failure, unknown external outcomes, reconnect/deduplication, localization keys, and per-attempt usage. These events extend the current journal rather than introducing a second event bus or independent error state machine.
