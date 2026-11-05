# Report 1: Coding-agent experience requirements

Date: 2026-11-05. Status: requirements analysis, not an implementation claim.

Related reports: [ACP and adapter capabilities](acp-capabilities.md), [open-source implementations](coding-agent-landscape.md).

## 1. Product goal

Whim should make using Claude Code and Codex as close as practical to using their native local CLIs, including when execution takes place on an ECS host. The goal is continuity of work and familiar capabilities, not merely a transcript viewer or a common chat layout. ACP is a candidate integration mechanism, not the product requirement.

Explicit requirements are local Codex and remote Claude Code, with local Claude Code and remote Codex supported by the same environment model; command candidates; streaming progress; session selection; preservation across page changes and client failures; visibility of externally submitted input; and attachment to the **same already-running execution**, not a replacement resumed from history. OpenCode is a comparison target and potential later integration, not a required initial implementation.

A terminal surface is a valid way to preserve native interaction. Structured chat is useful for search, attachments, tool presentation and local records, but cannot silently replace unavailable native behavior with a weaker approximation.

## 2. Identity and continuity

The following identities must not be collapsed into one session ID.

| Identity     | Meaning                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------- |
| Environment  | Machine, OS account, agent data/config home and executable installation                     |
| Workspace    | Absolute execution-side directory; optionally a Git worktree                                |
| Conversation | Provider-native durable history identifier                                                  |
| Execution    | Live owner of an agent run, with an execution generation                                    |
| Terminal     | PTY or tmux server/session/window/pane; distinct from a conversation                        |
| Connection   | One UI subscription or transport; disposable without necessarily ending execution           |
| Whim record  | Local durable observation or command receipt, scoped to the environment and native identity |

Three continuity levels should be named in the UI and acceptance tests: history resume, live structured attachment, and live terminal attachment. A restored conversation ID does not prove that tools, in-memory state or a pending turn survived. An unsubmitted terminal draft is not an accepted agent message.

## 3. Operations and acceptance criteria

The table separates direct user requirements (R) from supporting requirements proposed to make the experience reliable (S).

| ID  | Operation / requirement                    | Acceptance criterion                                                                                                                                                                |
| --- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R01 | Choose local or SSH execution              | The same agent choice works independently of host selection; remote work uses remote paths, credentials and binaries.                                                               |
| R02 | Choose a workspace                         | New sessions use its absolute execution-side path; existing sessions retain their identity and show their actual workspace.                                                         |
| R03 | Discover conversations and live executions | The UI distinguishes stored history, currently running, waiting for input, stopped and unreachable. A cached row is not evidence of liveness.                                       |
| R04 | Attach an existing tmux execution          | Connecting during a long task does not restart the CLI, create a second engine, submit a prompt or change the native conversation ID.                                               |
| R05 | Attach an existing non-tmux execution      | Succeed only with a verified native attach endpoint or existing broker. Otherwise explain the limitation; do not silently cold-resume it.                                           |
| R06 | Send normal prompts                        | Support multiline text, paste, Chinese IME and keyboard navigation. Show submitted, accepted and consumed states where knowable.                                                    |
| R07 | Discover and invoke slash commands         | `/com` filters actual session commands; selection inserts a command. Terminal mode preserves the CLI's own command UI.                                                              |
| R08 | Observe streaming work                     | Display incremental output, tool progress and waiting states without per-token full-history reloads. Preserve received interrupted output.                                          |
| R09 | Interrupt and continue                     | Stop targets the current turn or foreground activity. Follow-up input continues the intended conversation; cancellation does not imply rollback.                                    |
| R10 | Leave and return to a page                 | The execution continues. Reopening restores the current view without a new agent invocation.                                                                                        |
| R11 | Recover from client crash or SSH loss      | A surviving execution remains usable. The UI reconciles the gap and pending approvals; an uncertain prompt is not resent automatically.                                             |
| R12 | Observe external interaction               | Accepted input and output from another attached interface appear with provenance where supported. Terminal screen mirroring must not be labeled structured message synchronization. |
| S01 | Handle approvals and questions             | Correct tool/input controls, pending-state recovery and resolved-state invalidation; two clients cannot both claim their answer won.                                                |
| S02 | Preserve native configuration              | Keep agent-specific authentication, model, reasoning settings, skills, instructions, MCP and permission behavior. Show only supported controls.                                     |
| S03 | Attach files and images                    | Validate support and size, transfer local bytes to the execution host where required, and reference remote paths correctly.                                                         |
| S04 | Inspect changes and tools                  | Remote file links and diffs resolve remotely. Opening a view must not execute tools again.                                                                                          |
| S05 | Manage lifecycle explicitly                | Detach, interrupt, terminate, archive and delete are separate actions; closing a tab defaults to detaching.                                                                         |
| S06 | Retain local observations                  | Whim stores accepted commands and observed content once, with source identities. Global activity stores only atomic operation types and references.                                 |
| S07 | Remain responsive                          | Bound rendering, scrollback, output buffers and event queues. Page history. Measure startup, attach and input-to-display latency separately from inference time.                    |

Native keyboard commands, interactive authentication, shell escapes, plugins, custom commands, compaction, branching and terminal-only menus belong in a compatibility checklist per agent/version. They are not automatically implemented by exposing a model picker and a send button.

## 4. Required failure scenarios

These scenarios are the acceptance suite for a prototype; none has been executed by this research.

1. Start a long task in ECS tmux before opening Whim. Attach mid-turn and compare execution identity and progress. Type in both interfaces and confirm they refer to the same terminal/execution.
2. Switch pages repeatedly while output streams. Verify no interruption, duplicate subscription or extra model call.
3. Force-kill only the desktop, then reopen. Verify that the remote owner survived, recover display state, and distinguish restored snapshots from live events.
4. Break SSH before submission, after bytes are sent, and after remote acceptance but before local acknowledgment. Do not duplicate a prompt or external effect on reconnect.
5. Disconnect while an approval is open. Reconnect and approve only if the original request is still outstanding. Test another client resolving it first.
6. Kill the agent, then the remote broker, then reboot ECS. Report these separately: persistence may restore history but not the interrupted process. Never advertise reboot continuity from a successful network-disconnect test.
7. Import a stored conversation whose cwd has disappeared or whose data belongs to another OS user. Report a concrete error without silently changing workspaces or identities.
8. Attach to a plain, already-running CLI without an attach endpoint. Fail honestly or offer history resume as a different action; do not claim live attachment.
9. Exercise UTF-8/IME, large terminal output, resize, alternate screen, bracketed paste and local-to-remote image transfer. Do not convert terminal redraws into fabricated chat messages.

## 5. Persistence boundaries

Whim's SQLite remains authoritative for Whim-owned records and UI state. External agents retain authority over their internal conversation state and execution. Whim cannot reconstruct every hidden prompt, compaction detail or tool continuation merely by saving an ACP transcript.

For a remotely managed execution, client survival requires host-side ownership. The host can have a native provider store and a broker journal; introducing this is a deployment/storage design decision, not a hidden second database inside Whim. It must be reconciled explicitly with the current single-business-database design before implementation.

Terminal screen snapshots, terminal scrollback, structured message history and model context are different datasets. A terminal snapshot can restore the visible scene without restoring complete conversation history. A structured snapshot can restore chat without replaying every transient token. Full replay requires identity-aware reconciliation, not appending duplicate messages or deduplicating solely by matching text.

## 6. Implementation direction to validate

Prefer a capability-driven combination: native terminal attachment for existing tmux sessions; native shared-engine APIs where verified; ACP for interoperable structured sessions. Do not decide that every provider needs a custom daemon before testing reusable implementations.

The minimum prototype should test existing ECS tmux attachment and one structured live-attachment path independently. A successful history resume does not satisfy R04 or R05. No user should be forced to abandon a running task merely to adopt Whim.
