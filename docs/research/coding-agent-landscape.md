# Report 3: Open-source coding-agent clients and remote execution

Date: 2026-11-05. Scope: GitHub discovery, primary documentation and selected implementation inspection. No project was installed as a working product, no upstream test suite was run, and no ECS session was attached. This is a bounded architectural survey, not an exhaustive popularity ranking.

Related reports: [requirements](coding-agent-requirements.md), [ACP capabilities](acp-capabilities.md).

## 1. Method and interpretation

Searches targeted combinations of Claude Code, Codex, OpenCode, desktop, terminal, SSH, session attachment and reconnect. Nine clients are compared, plus OpenCode's own native server as an architectural reference. Projects were selected for distinct mechanisms and relevance, not stars.

Evidence labels below mean **S**: a relevant code path was inspected; **D**: supported by project documentation; **U**: not established by the inspected material. U is a research limitation, not a negative runtime capability value. Source links on moving branches were accessed on the report date and may drift; pinned links are used where a local checkout established the revision. A green upstream test or a README claim is not a live integration result.

“Remote” is split into SSH-managed execution, a network-accessible UI/relay, and remote access to a native engine. “Resume” is split into reading history into a new execution and attaching to a surviving execution. These distinctions materially change the comparison.

## 2. Comparison

This table is a navigation summary; the evidence and qualifications for each row follow it.

| Project                                             | Integration approach                                                              | Claude / Codex / OpenCode scope                                           | SSH / remote mechanism                                                      | Continuity boundary                                                                             | Evidence |
| --------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------- |
| [Emdash](https://github.com/generalaction/emdash)   | Desktop workspace, real CLIs, worktrees, hooks, persistent terminal layer         | All three documented                                                      | First-class SSH projects; remote workspace transport; tmux                  | TUI processes can outlive a view; does not imply structured adoption of arbitrary CLI processes | S + D    |
| [cmux](https://github.com/manaflow-ai/cmux)         | Native macOS Ghostty terminal with workspace/status integrations                  | CLI/TUI tools; Claude/Codex integrations documented                       | `cmux ssh`, remote workspace, file transfer                                 | Native terminal semantics; arbitrary existing-engine structured attach not established          | D        |
| [AgentC2](https://github.com/mlg151/AgentC2)        | Desktop SSH session manager, terminal and structured modes                        | Claude/Codex/Antigravity advertised; OpenCode integration not established | First-class OpenSSH, Linux remote helpers and tmux                          | Terminal tab detach preserves remote processes; mode-specific chat behavior differs             | S + D    |
| [HAPI](https://github.com/tiann/hapi)               | Agent wrappers, Runner, Hub, Web/native clients; provider-specific engines        | All three documented                                                      | Network Hub/relay and remote Runner; not primarily an SSH workspace picker  | New Codex path shares one engine; Claude path includes mode handoff                             | S + D    |
| [Happy](https://github.com/slopus/happy)            | Original CLI wrapper and encrypted relay; separate newer desktop/runtime projects | Original CLI Claude/Codex; newer product advertises OpenCode/ACP          | Relay-based remote control; SSH workspace provisioning not established here | Original Claude handoff can stop the local process; do not generalize across generations        | S + D    |
| [MonoCode](https://github.com/hardbeat920/monocode) | Structured desktop UI plus host-owned provider runtimes                           | All three documented                                                      | SSH bootstrap, background service, private port forward                     | Host owns execution and persistence; reconnect syncs snapshots/changed blocks                   | S + D    |
| [AionUi](https://github.com/iOfficeAI/AionUi)       | Electron frontend, backend, built-in and ACP-connected agents                     | All three documented                                                      | WebUI/channels for remote access; first-class SSH execution not established | Remote UI access is not proof of adoption of an independently running CLI                       | D        |
| [Zed](https://github.com/zed-industries/zed)        | Separate ACP External Agents and real Terminal Threads                            | All three in external-agent catalog                                       | SSH headless project server and remote terminals                            | Terminal and structured surfaces deliberately distinct; arbitrary CLI takeover not promised     | D        |
| [Opcode](https://github.com/winfunc/opcode)         | Tauri/Rust GUI launching Claude CLI with JSON streaming                           | Claude-focused; not verified as a three-agent aggregator                  | No first-class SSH session manager established in inspected code            | Launch/continue/resume subprocesses, not proof of same-process attachment                       | S        |

## 3. Terminal-preserving implementations

### Emdash

Emdash combines parallel agent tasks with isolated Git worktrees, local SQLite application state and remote SSH/SFTP workspaces. Lifecycle hooks add status/notifications around native agent CLIs. Its remote-project documentation states that terminal/TUI processes use tmux for independence from attached views; machine reboot remains a separate failure. [README](https://github.com/generalaction/emdash/blob/main/README.md), [remote projects](https://emdash.com/docs/remote-development/remote-projects).

Current source was inspected at `592281113a9d83a2987d8a1715d0fedf854d44c4`. `buildTmuxShellLine` checks for an existing named session, creates it detached only when absent, then attaches. It stores an identity option and provides inventory and explicit kill operations. The remote workspace transport forwards an SSH stream-local channel to the workspace server socket. This is more concrete than “put SSH in an embedded terminal.” [tmux commands](https://github.com/generalaction/emdash/blob/592281113a9d83a2987d8a1715d0fedf854d44c4/packages/core/src/services/pty/api/tmux-commands.ts), [SSH transport](https://github.com/generalaction/emdash/blob/592281113a9d83a2987d8a1715d0fedf854d44c4/apps/emdash-desktop/src/core/services/hosts/node/workspace-server/connect/ssh-streamlocal-transport.ts).

Whim lesson: separate workspace operations, session ownership and terminal views; preserve actual native interaction. Existing-session import policy still needs verification: a reusable tmux attach primitive does not prove the product imports every unmanaged pane. Older indexed source showed a different layout, so it was not used as current implementation evidence.

### cmux

cmux uses Swift/AppKit and libghostty rather than recreating CLI interaction as chat. Its documented `cmux ssh` creates a remote workspace, routes browser panes through the remote network and uploads dropped images using scp. Sidebar status and notification integrations sit beside the terminal. [README](https://github.com/manaflow-ai/cmux/blob/main/README.md).

Whim lesson: native CLI compatibility comes from retaining a real terminal, including terminal-only menus and keyboard behavior. Status integrations should supplement that terminal rather than pretend to reconstruct complete semantic history. The inspected documentation establishes SSH support, but this review did not audit its disconnect/crash implementation or prove arbitrary process adoption. Do not import its current crash-recovery claims as a Whim guarantee without a process-lifetime test.

### AgentC2

This is unusually close to the ECS use case: a desktop SSH manager with multiple hosts and persistent terminal sessions. Its documented setup requires OpenSSH locally and Python/tmux on Linux hosts. It supports terminal views and separate structured Claude/Antigravity modes, with provider authentication on the execution host. Closing a terminal tab detaches while remote work remains; unreachable hosts keep visibly stale cached inventory. [README](https://github.com/mlg151/AgentC2/blob/main/README.md).

Source at `dcd356f1ab1950525af0cc83c4deb31e09846fa6` confirms `ssh -tt ... tmux attach-session` in the service, bounded exponential reattachment in the terminal manager, and a separate tmux control-mode connection for history/input operations. The reconnect guide explicitly distinguishes a terminal redraw from transcript recovery and states that no remote daemon is required for this terminal path. [Service](https://github.com/mlg151/AgentC2/blob/dcd356f1ab1950525af0cc83c4deb31e09846fa6/electron/service.cjs), [terminal manager](https://github.com/mlg151/AgentC2/blob/dcd356f1ab1950525af0cc83c4deb31e09846fa6/electron/terminals.cjs), [tmux control](https://github.com/mlg151/AgentC2/blob/dcd356f1ab1950525af0cc83c4deb31e09846fa6/electron/tmux-control.cjs), [reconnect contract](https://github.com/mlg151/AgentC2/blob/dcd356f1ab1950525af0cc83c4deb31e09846fa6/docs/reconnect.md).

Whim lesson: host-qualified identities, live-versus-stale status and explicit detach semantics matter as much as the chat surface. This is a high-priority hands-on candidate. Structured-mode ownership and OpenCode-specific integration were not verified; terminal recovery must not be generalized to all modes.

## 4. Shared engines, wrappers and remote hosts

### HAPI: distinguish Codex from Claude

HAPI has a CLI wrapper and Runner connecting to a Hub over Socket.IO; the Hub stores sessions/messages in SQLite and serves clients through REST and SSE. A remote Runner can execute agents on another machine; relay/tunnel deployment is distinct from a desktop SSH workspace integration. [Architecture](https://github.com/tiann/hapi/blob/main/docs/guide/how-it-works.md).

For Codex 0.154.0+, its documentation describes the terminal and Web/native clients sharing one App Server. `hapi resume` attaches to a live execution; a cold native-thread resume rejects another live owner. Terminal-created execution lifetime belongs to its primary terminal; additional terminals detach without becoming owners. Runner-created execution needs no primary terminal. Therefore “close any terminal and it keeps working” would be inaccurate. [Shared-session contract](https://github.com/tiann/hapi/blob/main/docs/guide/codex-shared-sessions.md).

The implementation supports that distinction: `attachSharedSession` locates a runtime endpoint/token, calls `hapi/attach`, then launches the same recorded executable using `--remote ... resume <threadId>`. This is a native shared-server path, not ACP over a newly spawned standalone process. It requires a registered live execution and is not demonstrated as universal adoption of any previously started Codex CLI. [Attachment code](https://github.com/tiann/hapi/blob/main/cli/src/codex/shared/frontend.ts).

Claude takes a different route. Its local launcher scans native transcripts and forwards observations; `BaseLocalLauncher` handles a remote message by requesting a switch and aborting the local launcher. The local CLI launch can use `--resume`. Thus the general README's seamless-handoff language is not sufficient evidence of uninterrupted same-process Claude execution. [Local observation](https://github.com/tiann/hapi/blob/main/cli/src/claude/claudeLocalLauncher.ts), [switch handling](https://github.com/tiann/hapi/blob/main/cli/src/modules/common/launcher/BaseLocalLauncher.ts), [CLI spawn](https://github.com/tiann/hapi/blob/main/cli/src/claude/claudeLocal.ts).

Whim lesson: test native shared-engine APIs before building a universal broker. Keep per-provider lifetime and handoff semantics visible.

### Happy: do not mix product generations

The current repository separates the original CLI/mobile/relay system from `happy-desktop` and `happy-agent`, which implement the newer desktop/runtime product. Its advertised multi-agent/multiplayer capabilities should not be retroactively attributed to the original wrapper. [Repository map](https://github.com/slopus/happy/blob/main/README.md).

In the inspected original Claude implementation, `claudeLocalLauncher` observes a native transcript. Incoming remote messages request a switch and abort the local process; `loop.ts` selects local or remote launchers. The remote launcher handles SDK messages and permissions. This is conversation continuity through a wrapper, not proof that the exact foreground process and in-flight task survive the switch. [Local launcher](https://github.com/slopus/happy/blob/main/packages/happy-cli/src/claude/claudeLocalLauncher.ts), [loop](https://github.com/slopus/happy/blob/main/packages/happy-cli/src/claude/loop.ts), [remote launcher](https://github.com/slopus/happy/blob/main/packages/happy-cli/src/claude/claudeRemoteLauncher.ts).

Whim lesson: transcript observation can expose terminal-originated input, with completeness/latency tied to what the CLI writes. Remote access through an encrypted relay is useful but is not SSH execution management. The newer desktop and harness need a separate audit before reuse; they were identified, not deeply inspected here.

### MonoCode: closest host-owned structured-session reference

MonoCode documents experimental remote execution via SSH-installed host packages, background services, per-device pairing and private forwarding. The host owns processes and session storage; closing the desktop/tunnel does not stop them. Reconnection obtains persisted state and changed transcript blocks; uncertain requests retain their command IDs. Remote feature parity is incomplete, including restrictions on terminals and slash commands. [Remote access](https://github.com/hardbeat920/monocode/blob/main/docs/remote-access.md).

Source checkout `9ee7b3dd1e408a76229d60fc2db29d1ec45728ea` was also obtained. `host/server.ts` exposes the host surface; `HostEngine` owns running/live session maps and a Store. It batches streaming events, persists actionable events promptly, and marks running sessions interrupted after host restart instead of blindly replaying provider calls. This explicitly separates client disconnection from host crash. [Server](https://github.com/hardbeat920/monocode/blob/9ee7b3dd1e408a76229d60fc2db29d1ec45728ea/host/server.ts), [engine](https://github.com/hardbeat920/monocode/blob/9ee7b3dd1e408a76229d60fc2db29d1ec45728ea/host/engine.ts).

Whim lesson: this is an existing example of the additional host layer discussed in the ACP report. Reuse the ownership/receipt/snapshot ideas rather than assuming every stream needs permanent per-token persistence. It manages host-owned sessions; arbitrary existing tmux CLI adoption was not established. Host storage also requires an explicit decision relative to Whim's single local business database.

## 5. Structured UI and alternative surfaces

### AionUi

AionUi documents an Electron frontend and separate backend, built-in agent functionality, and external agent integration through ACP. It advertises Claude, Codex, OpenCode and other CLIs, parallel sessions and WebUI/channel access. [README](https://github.com/iOfficeAI/AionUi/blob/main/readme.md).

Whim lesson: capability-aware multi-agent presentation can coexist with an application's own agent. Its remote WebUI access must not be mislabeled as first-class SSH execution or existing-process takeover. Those features were not established from the inspected material; this is not a proof of their absence. It is a useful ACP UX reference, not yet a demonstrated solution to the user's tmux requirement.

### Zed

Zed explicitly separates ACP External Agents from Terminal Threads. The former render structured agent interactions; the latter run native CLIs/TUIs and leave authentication, tools, skills and configuration with the CLI. [External agents](https://zed.dev/docs/ai/external-agents), [terminal threads](https://zed.dev/docs/ai/terminal-threads).

Its remote architecture uses a headless project server over SSH while the UI remains local. This establishes remote workspace/terminal support, not universal lifetime or native-CLI adoption guarantees for every ACP agent. [Remote development](https://zed.dev/docs/remote-development).

Whim lesson: a shared session navigation experience does not require forcing terminal sessions and structured sessions into identical control semantics. Zed is a concrete precedent for offering both surfaces rather than declaring one a failed version of the other.

### Opcode

Source at `d1ca30a3c0c39fff01fde2f86c2d5af6a1db658b` shows Rust/Tauri commands launching Claude with `stream-json`, plus continue/resume invocation paths and asynchronous stdout consumption. This is a subprocess/structured-stream GUI approach. [Implementation](https://github.com/winfunc/opcode/blob/d1ca30a3c0c39fff01fde2f86c2d5af6a1db658b/src-tauri/src/commands/claude.rs).

Whim lesson: a native CLI can be rendered structurally without ACP, but the application then maintains provider-specific parsing and lifecycle code. It is included as a contrasting Claude-focused design, not presented as a verified Codex/OpenCode or SSH aggregator. Same-process attachment was not demonstrated by the inspected resume implementation.

### OpenCode's native server: an important reference, not an aggregator

OpenCode itself separates its TUI from an HTTP server, offers HTTP/OpenAPI and SSE events, and documents connecting to the server used by an existing TUI when its address is known. Starting a new `opencode serve` is not the same as attaching to the existing TUI's server. [Server documentation](https://opencode.ai/docs/server/).

Whim lesson: where a native server already owns execution, use that boundary rather than introduce another engine. Reachability through an SSH tunnel is an architectural option, not evidence that every client above implements SSH setup or durable event replay. OpenCode's multi-client architecture also cannot be used as proof that Claude exposes the same API.

## 6. What this changes for Whim

The evidence supports three complementary mechanisms, not one universal protocol:

| Need                                                         | Best candidate to validate                     | Main tradeoff                                                   |
| ------------------------------------------------------------ | ---------------------------------------------- | --------------------------------------------------------------- |
| Operate an already-running ECS tmux CLI with native fidelity | Terminal attachment; study AgentC2 and Emdash  | Screen/byte-stream semantics, not complete structured chat      |
| Keep native Codex TUI and structured UI on one execution     | Native App Server sharing; study HAPI          | Version/startup/ownership prerequisites; not arbitrary adoption |
| Run managed structured sessions independently of the desktop | Remote host; study MonoCode                    | Host deployment, credentials, persistence and reconciliation    |
| Add broad agent interoperability                             | ACP; study Zed and AionUi                      | Adapter/CLI feature gaps and no automatic remote durability     |
| Observe terminal activity without replacing it               | Hooks/transcript observation; study HAPI/Happy | Observational completeness differs from direct engine events    |

Recommended investigation order: (1) same-pane ECS tmux attachment; (2) HAPI-style Codex live sharing; (3) managed Claude ACP session with host-owned lifetime; (4) recovery and multi-client reconciliation across these paths. Keep the native terminal as an intentional surface for unsupported structured operations.

Corrections to the earlier discussion: a custom remote daemon is not always necessary; existing native servers or tmux may supply ownership. Conversely, a product claiming “same session” or “seamless handoff” may still replace its process. ACP is neither the only route to structured interaction nor sufficient evidence of live attachment.

## 7. Validation before selection

Install only the shortlisted candidates in an isolated test workspace, pin releases and record the actual engine PID/runtime identity, not just conversation IDs. Repeat the scenarios in Report 1. Specifically test terminal-originated accepted input, two-client approvals, reconnect during tool execution, loss of the primary terminal, desktop crash and owner-process crash separately.

Outstanding: real ECS verification; released-version comparison against inspected main branches; AgentC2 structured-mode audit; cmux recovery audit; Happy's newer desktop/runtime audit; AionUi SSH support beyond the inspected documentation; and performance measurements. These gaps do not invalidate the observed designs, but prevent claiming any candidate already satisfies every Whim requirement.
