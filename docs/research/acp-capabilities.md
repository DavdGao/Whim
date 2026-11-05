# Report 2: ACP capabilities, adapters and gaps

Date: 2026-11-05. Status: protocol/documentation and source inspection; no ECS integration test.

Related reports: [requirements](coding-agent-requirements.md), [implementation landscape](coding-agent-landscape.md).

## 1. Evidence baseline

ACP's documentation labels v1 current and v2 draft. Negotiate the protocol and capabilities; do not infer feature support from an SDK type or package name. A draft, optional extension, implementation on main and published release are different states.

The adapter sources inspected are:

- [codex-acp at 519c267](https://github.com/agentclientprotocol/codex-acp/tree/519c2671bfe8266b7625b1cebde7657b5f6d1303): package manifest 2.5.0, SDK dependency `~2.4.0`, Codex dependency `^0.166.0`.
- [claude-agent-acp at a79d073](https://github.com/agentclientprotocol/claude-agent-acp/tree/a79d07324dc15808c94a889a3b60615cca5a9fbd): package manifest 0.100.0, SDK 2.4.0 and Claude Agent SDK 0.3.318.

These identify inspected source, not a claim that all changes at those commits are in an installed stable release. Both repositories describe preview distribution. The old zed-industries Codex repository is archived and points to the agentclientprotocol repository.

## 2. What the protocol provides

The following is an integration matrix, not a promise that every agent implements every row.

| Surface             | Protocol mechanism                                                                       | Boundary / Whim responsibility                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Startup             | `initialize`, protocol/capability negotiation, agent identity and authentication methods | Install/locate a compatible executable; handle host authentication separately from provider authentication.      |
| Prompt              | `session/prompt` with content blocks                                                     | Respect negotiated input support; implement attachment preparation and transfer.                                 |
| Streaming           | `session/update` notifications                                                           | Fold chunks and tool updates; chunks are not necessarily individual tokens.                                      |
| Completion          | v1 prompt response with stop reason                                                      | Transport EOF is not successful completion.                                                                      |
| Commands            | `available_commands_update`                                                              | Cache the advertised list, replace it on update, filter locally; no general dynamic argument-completion service. |
| Tools               | Tool call and update notifications; permission requests                                  | Tool status is structured; do not execute an observed tool again.                                                |
| Cancellation        | `session/cancel`                                                                         | Observe actual terminal outcome; cancellation is not rollback.                                                   |
| Settings            | Session configuration/options and supported mode/model surfaces                          | Options are agent-specific; preserve unknown extension data without presenting unsupported controls.             |
| New session         | `session/new` with execution-side cwd                                                    | A workspace is not a conversation identity.                                                                      |
| List                | Optional `sessionCapabilities.list` / `session/list`                                     | Paginated metadata, optionally cwd-filtered; not a universal live-process inventory.                             |
| Load                | Optional `loadSession` / `session/load`                                                  | History replay through notifications; do not duplicate cached history.                                           |
| Resume              | Optional `sessionCapabilities.resume` / `session/resume`                                 | Restores without historical replay; not a guarantee of attachment to an arbitrary live CLI.                      |
| Close               | Optional `sessionCapabilities.close`                                                     | Frees active resources/cancels work; differs from disconnecting a view.                                          |
| Files and terminals | Negotiated client-side filesystem/terminal services                                      | In SSH mode route execution to the intended host; never resolve a remote path on the Mac accidentally.           |

Sources: [initialization](https://agentclientprotocol.com/protocol/v1/initialization), [prompt lifecycle](https://agentclientprotocol.com/protocol/v1/prompt-turn), [commands](https://agentclientprotocol.com/protocol/v1/slash-commands), [session setup](https://agentclientprotocol.com/protocol/v1/session-setup), [session list](https://agentclientprotocol.com/protocol/v1/session-list), [filesystem](https://agentclientprotocol.com/protocol/v1/file-system), [terminals](https://agentclientprotocol.com/protocol/v1/terminals).

For `/com`, Whim filters names from the current session's advertised commands and can show description and input hint. Submission remains a normal prompt containing `/compact ...`. Do not hard-code the native CLI's complete command menu or assume branch/file argument suggestions are available.

Useful stream variants include `agent_message_chunk`, `agent_thought_chunk`, `user_message_chunk`, `tool_call`, `tool_call_update` and `plan`. A user-message variant makes external input representable, but does not make another independent process publish it automatically. Exposed reasoning is not a guarantee of complete internal reasoning access.

## 3. What the two packages actually implement

### Codex

The adapter is a stdio ACP server that starts Codex App Server and translates requests/events. Its current manifest includes a compatible Codex dependency; `CODEX_PATH` can override the executable. Using the adapter does not inherently mean using the exact CLI binary already on the user's PATH. [README](https://github.com/agentclientprotocol/codex-acp/blob/519c2671bfe8266b7625b1cebde7657b5f6d1303/README.md).

`CodexAcpServer.initialize` advertises load, list, resume and close. `CodexAcpClient.listSessions` maps native threads, including CLI/app-server sources, and excludes exec/review runs. `resumeSession` invokes native thread resume. `CodexCommands` publishes built-in commands and skills. These are real implementation paths, not merely protocol possibilities. [Server](https://github.com/agentclientprotocol/codex-acp/blob/519c2671bfe8266b7625b1cebde7657b5f6d1303/src/CodexAcpServer.ts), [client](https://github.com/agentclientprotocol/codex-acp/blob/519c2671bfe8266b7625b1cebde7657b5f6d1303/src/CodexAcpClient.ts), [commands](https://github.com/agentclientprotocol/codex-acp/blob/519c2671bfe8266b7625b1cebde7657b5f6d1303/src/CodexCommands.ts).

It also has specialized extensions and recovery code. Therefore saying the package has “no session management or recovery” would be incorrect. The missing demonstrated guarantee is a general remote, durable, multi-client service that adopts arbitrary pre-existing terminal executions. The native App Server can expose capabilities beyond ACP; native live sharing deserves a separate integration path rather than assuming ACP is the maximum possible capability. [OpenAI App Server](https://learn.chatgpt.com/docs/app-server).

### Claude

The adapter uses Claude Agent SDK. `listSessions` calls the SDK's disk-session listing with cwd filtering. `loadSession` replays history; `resumeSession` skips replay. `getOrCreateSession` reuses a matching query already owned by that adapter instance, otherwise creates a query with `resume: sessionId`. It is not a tmux attachment operation. [Implementation](https://github.com/agentclientprotocol/claude-agent-acp/blob/a79d07324dc15808c94a889a3b60615cca5a9fbd/src/acp-agent.ts).

Commands come from `query.supportedCommands()` and are filtered, including terminal-bound commands. Consequently a structured UI does not necessarily preserve every CLI menu. The SDK can enumerate transcripts written by native Claude Code, but shared stored history does not prove shared live execution. [SDK session browser](https://platform.claude.com/cookbook/claude-agent-sdk-05-building-a-session-browser).

Claude's own Remote Control is another mechanism, with its own supported clients and restrictions. It must not be described as a generic ACP endpoint or assumed to provide a supported third-party attach API. [Remote Control](https://code.claude.com/docs/en/remote-control).

## 4. Transport and lifecycle gaps

Current v1 standard transport is newline-delimited JSON-RPC on stdio; custom transports are permitted and a remote transport is being specified. SSH can carry clean stdio without a PTY. A terminal attachment instead requires a PTY/terminal transport. Mixing terminal escape output into ACP stdout breaks the framing contract. [Transports](https://agentclientprotocol.com/protocol/v1/transports).

The following requirements need more than basic stdio ACP:

| Requirement                      | Additional mechanism                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Keep working after desktop death | Independent process owner: native server, supervisor, broker or tmux for terminal sessions                          |
| Reconnect mid-turn               | Reach the same surviving owner and subscribe to current activity                                                    |
| Recover missed events            | Durable cursor/replay or authoritative snapshot reconciliation; standard load is not an after-sequence catch-up API |
| Multiple writers                 | Native engine arbitration or explicit control ownership; deduplicate commands and approvals                         |
| Attach arbitrary existing CLI    | An existing native endpoint, registered wrapper or terminal multiplexer; history resume is insufficient             |
| Synchronize external input       | Engine event subscription, wrapper/hooks or transcript observation with stated latency and completeness             |
| Survive host reboot              | Restore history and mark interrupted work; live process state does not survive merely because a database exists     |
| Preserve all native CLI behavior | Real terminal path, or a verified per-feature native API mapping                                                    |

A broker need not reimplement ACP adapters. It can own one or more adapter connections, expose authenticated client attachment, and record observations/receipts. But this should be a response to proven gaps, not an automatic requirement for every provider: OpenCode and newer Codex shared-server workflows already offer useful native primitives.

## 5. Four concrete scenarios

1. **Connect during an existing task:** standard ACP does not discover and attach every native CLI process. A surviving managed adapter may reuse its own session; an unrelated Claude CLI is a separate case. Native shared-engine integration or tmux attachment can provide stronger continuity.
2. **Reopen after desktop crash:** local SQLite can immediately restore previously observed UI history. A subsequent load replays remote history; resume does not. Neither guarantees a complete internal context dump or arbitrary after-sequence catch-up. Reconcile before declaring the view live.
3. **Leave the page:** only unsubscribe the view; keep the backend owner alive. **Lose the desktop:** continuity depends on the execution host, not the existence of a session ID. Remote approvals may leave work waiting even while the process survives.
4. **Type in another terminal:** ACP can represent user messages but does not monitor independent CLI instances. A shared tmux pane mirrors terminal I/O; a shared native server can broadcast accepted inputs; two engines resuming one transcript are not an acceptable synchronization strategy.

## 6. Decision and validation gates

Use ACP as an interoperable structured surface, not as a universal remote-process manager. Keep terminal and structured capabilities explicit. Prototype against pinned released binaries and record initialize payloads, exact versions, process ownership and observed events.

Before implementation selection, run: mid-turn attach; terminal/Web simultaneous input; pending approval resolved elsewhere; SSH failure around prompt acceptance; desktop kill; owner-process kill; history replay with partial output; and cwd/config-home mismatch. Inspect wire behavior instead of treating upstream tests or claims as Whim integration results. This report ran no paid model requests and no ECS experiments.
