# External Coding Agents: Terminal Integration Design

Status: planned design; no implementation or live ECS verification is implied.

Whim provides a near-native Claude Code and Codex experience on the Mac and on SSH-accessible ECS hosts. Users and Whim's own agent can operate the same terminal execution. Independent collection of native events and conversation logs makes those interactions available as local Whim data.

This feature does not depend on ACP. [design.md](../design.md) defines shared application services and persistence; [agent.md](../agent.md) defines how Whim's own agent consumes observations and calls tools. The earlier [requirements report](coding-agent-requirements.md), [ACP assessment](acp-capabilities.md), and [implementation survey](coding-agent-landscape.md) remain research references rather than the selected architecture.

## 1. Goals and boundaries

The initial targets are local Codex and remote Claude Code, with local Claude Code and remote Codex using the same environment abstraction. OpenCode and other CLIs may run as ordinary terminal applications; their structured collection requires separate integrations.

The design supports:

- Real CLI interaction, including native commands, menus, keyboard shortcuts, approvals and settings.
- Attachment to an existing tmux execution without restarting it or creating a second agent engine.
- Remote execution that survives leaving a page, closing Whim or losing the SSH connection while the host and tmux remain alive.
- Local records of submitted messages, observable replies, tool events and terminal operations, with explicit source and completeness information.
- Whim-agent observation and operation of a user-authorized terminal.

A plain, already-running CLI outside tmux cannot be assumed attachable. Without a verified native attachment endpoint, offer historical resume as a distinct action, never as an equivalent to live attachment. Host reboot, agent crash and tmux termination do not preserve process memory or in-flight work.

Whim records observable interaction, not a complete copy of an external agent's internal model context. Terminal redraws, screen snapshots, conversation messages and internal context are different datasets.

## 2. Architecture and technology

The terminal path remains usable independently of structured conversation parsing. The collector adds records and status without becoming a new reasoning engine.

```text
Whim Renderer
  Terminal view | Session list | Interaction history | Whim agent controls
                            |
Whim Backend / Core
  Environment and terminal services | Input ownership | Store and file service
                            |
                 Local execution or OpenSSH
                            |
Execution host
  tmux -> native Claude Code / Codex CLI
  Collection helper -> native logs, hooks, pending-event spool
```

The following technologies define the implementation direction; platform behavior must be validated in the prototype.

| Layer                | Technology                                     | Responsibility                                                               |
| -------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------- |
| Desktop              | Electron, TypeScript, React                    | Host the feature and its lifecycle                                           |
| Application controls | Official shadcn/ui, Tailwind CSS, lucide-react | Session navigation, history, status and settings                             |
| Terminal rendering   | xterm.js, subject to Electron validation       | Native TUI rendering, keyboard input, paste, resize and scrolling            |
| Local PTY bridge     | node-pty, subject to native-module validation  | Connect interactive processes to the renderer through typed Backend services |
| Remote transport     | System OpenSSH                                 | Reuse SSH config, keys, agent, jump hosts and host verification              |
| Terminal ownership   | tmux                                           | Keep the CLI and terminal scene independent of attached views                |
| Collection helper    | TypeScript on Node.js                          | Observe native logs, receive hooks, spool events and synchronize             |
| Provider integration | Claude and Codex plugins                       | Discover conversations and normalize provider-specific observations          |
| Persistence          | Existing SQLite and Core file service          | Durable observations, receipts, cursors and recording references             |

Interactive attachment uses a PTY. Inventory, helper communication and file transfer use separate noninteractive operations; terminal control sequences must never contaminate collector framing. SSH authentication and provider authentication remain separate. Provider credentials stay with the execution-side user unless a later explicit feature changes that arrangement.

## 3. Identity and session operations

Identify an execution environment by host, OS account and relevant configuration/data homes. Keep native conversation ID, execution generation, tmux server/session/window/pane, Whim record ID and client connection ID distinct. A directory is execution context, not session identity. A reused pane name or PID is not sufficient proof of execution continuity.

| Operation                   | Mechanism                                    | Behavior                                                               |
| --------------------------- | -------------------------------------------- | ---------------------------------------------------------------------- |
| Choose a host               | Local environment or SSH configuration       | Agent selection is independent of location                             |
| Choose a project            | Execution-side absolute directory            | Remote paths never resolve against the Mac                             |
| Create a terminal session   | Start the native CLI inside tmux             | Use the selected environment and native configuration                  |
| Attach live work            | Enumerate and attach an existing tmux target | Do not submit a prompt, restart the CLI or create a replacement engine |
| Browse stored conversations | Provider-specific index/log discovery        | Display separately from live terminal inventory                        |
| Resume history              | Explicit native CLI resume invocation        | Label as historical resume, not live attachment                        |
| Change pages                | Subscribe/unsubscribe Renderer views         | Backend retains execution and collection ownership                     |
| Close a tab                 | Detach its view                              | Do not implicitly interrupt or terminate work                          |
| Interrupt                   | Native control input, then observation       | Request cancellation; verify what actually stopped                     |
| Terminate                   | Explicit targeted process/session operation  | Distinct from detach and archive                                       |
| Reconnect                   | Reattach and reconcile collected events      | Restore the scene and label any remaining gaps                         |

For local persistence, tmux is also the proposed owner. Detect its availability and make installation/setup explicit; do not silently depend on an absent binary. A child owned only by the desktop cannot be advertised as surviving desktop failure.

## 4. Native interaction and frontend

The terminal preserves the CLI's own slash-command candidates, argument input, model/reasoning settings, permission modes, skills, MCP configuration and interactive menus. Whim does not initially maintain a duplicate command catalog or rebuild every native CLI setting as a form.

The feature offers host/project/session navigation, a live terminal, structured interaction history when available, connection status and agent-control indicators. Application strings follow the existing English/Simplified Chinese catalogs; user content and CLI output remain untranslated.

Support multiline text, Chinese IME, bracketed paste, keyboard shortcuts, alternate-screen applications, resize and bounded scrollback. Distinguish connected, reconnecting, unreachable, running, waiting and exited. Connection health is not proof that the agent is actively reasoning; terminal output activity is not sufficient proof either.

Dragging a local file into a remote terminal first transfers the bytes, then uses a provider-supported path or attachment mechanism. Validate size and destination, preserve correct quoting, and distinguish uploaded from accepted by the CLI. Do not assume pasting a file path constitutes native image ingestion. Remote links, file inspection and diffs use the remote environment.

## 5. Collection and records

Use complementary sources rather than treating terminal bytes as a structured conversation protocol.

| Source                           | Data                                                                         | Limits                                                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Native conversation logs         | Submitted messages, stored replies and recorded tool information             | Fields, write timing and completeness depend on the provider/version                                      |
| Hooks or supported native events | Submission, tool lifecycle, approval and completion observations             | Only events actually exposed by the installed version are available                                       |
| Terminal stream and snapshots    | Output bytes received by Whim, Whim-originated operations and visible scenes | Redraws have no reliable chat-message boundaries; external keystrokes are not all visible as input events |

Provider plugins discover log locations using the execution user's configuration, track file identity and read positions, and handle partial writes, replacement and rotation. Do not modify native logs. Parse failures should suspend or degrade collection for that source without breaking the terminal.

Each observation retains environment, native conversation identity when known, execution association, source type, source position/ID, observation time and completeness. Preserve source timestamps separately when available. Do not fabricate a conversation association before it can be established.

Use native IDs and source positions for deduplication. When a hook and a log describe the same message, link or reconcile their observations; identical text alone is not a safe deduplication key. Persist content once and reference it from activity indexes. Global activity remains an atomic operation index without duplicated logical content.

The main conversation history records accepted/submitted messages, not every editing keystroke. Terminal operations and optional recordings form a separate history. Sensitive entry and authentication must be excluded or recording paused; ordinary terminal output can also contain sensitive material, so a recording is not automatically safe because input capture is disabled. Do not claim perfect automatic secret detection.

External-terminal input can be observed after it enters a tracked native log or hook stream. Screen mirroring alone does not identify the author or establish the final submitted text. Historical import cannot recover transient events that were never retained.

## 6. Machine-side helper and persistence

The helper is a collection and synchronization component, not an agent server. It does not implement a reasoning loop, start a second engine when attaching, or take ownership of the external agent's internal context. Keep ordinary tmux attachment available even when the helper is unavailable; clearly show that structured collection is degraded.

On ECS, the helper must run independently of the SSH connection when disconnected-time collection is enabled. Prefer a user-level service where supported; otherwise expose the weaker detached-process lifetime explicitly. Installation, version checks, updates and removal are deliberate lifecycle operations. Updating the helper must not implicitly restart an unrelated CLI.

Whim keeps one local business database:

- SQLite holds received observations, command receipts, terminal/session metadata and synchronization positions.
- The external agent retains its native conversation store on the execution host.
- A bounded, append-only host file spool retains unsynchronized collector events. It is a delivery journal, not a second Whim business database.
- Core-managed segmented files hold terminal recordings; SQLite contains their indexes and references. Existing file publication and reconciliation rules apply.

Each spool stream has a persistent identity/generation and monotonic sequence. Whim acknowledges a position only after committing received records and its cursor together. Reconnect can replay unacknowledged events safely. Handle duplicate delivery, a reset spool and a changed host identity explicitly.

Bound disk usage and event sizes. Retain unacknowledged records until acknowledgment or an explicit retention decision; if capacity requires dropping data, publish a gap marker rather than claiming complete history. Without an independent collector or retained native source, disconnected-time capture cannot be guaranteed.

This preserves SQLite as authority for Whim-owned received data. Unsynchronized remote facts necessarily exist before the Mac receives them; the local database must not claim authoritative current execution state while disconnected.

## 7. Recovery and uncertain operations

| Failure                   | Expected behavior                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| Renderer leaves the page  | Dispose UI subscriptions; keep Backend terminal/collector ownership                                   |
| Desktop closes or crashes | Remote tmux and independently hosted collector continue; pending interaction may still block the CLI  |
| SSH drops                 | Mark state stale, reject new terminal writes, retry attachment with bounded backoff                   |
| Connection returns        | Restore terminal scene and ingest missing events; distinguish snapshot recovery from semantic history |
| Helper crashes            | Native CLI continues; recover from retained logs/spool where possible and disclose gaps               |
| CLI or tmux exits         | Show exited/interrupted; do not silently recreate the execution                                       |
| ECS reboots               | History may remain; no promise of process-memory or in-flight-tool recovery                           |

Terminal bytes written to SSH are not an acknowledgment that the agent consumed a prompt. Record operation intent and submission outcome separately. Do not automatically resend input after a transport failure or timeout where delivery is uncertain. Reobserve and reconcile; ask the user when the actual outcome cannot be established.

Tmux screen redraw restores a visible scene, not necessarily all scrollback or all conversation messages. Native log import and collector catch-up are separate operations. Interrupted output already received by Whim must not disappear merely because a later reconnect lacks it.

## 8. Whim-agent control

Expose terminal control through the same Core command services used by the UI. The conceptual capabilities are:

| Capability         | Mechanism                                                                   |
| ------------------ | --------------------------------------------------------------------------- |
| Discover terminals | Environment/session inventory                                               |
| Observe            | Current pane screen, cursor and dimensions; rendered screenshot when needed |
| Enter text         | Literal text or paste, separate from submission                             |
| Navigate menus     | Explicit named key inputs such as arrows, Tab, Enter and Escape             |
| Interrupt          | Targeted native control key and subsequent verification                     |
| Follow progress    | Collector events and bounded terminal observation                           |
| Handle approvals   | Verified structured hook where available; otherwise terminal interaction    |

The agent operates in an observe-action-observe loop. Keep actions short, bind them to an explicit target and recent observation, then verify the resulting screen or native event. Terminal output is untrusted task data, not an instruction granting additional authority.

The user owns input by default. Explicit delegation gives the Whim agent a scoped control lease; the user can revoke or take back control immediately. Coordinate all Whim-originated input through one owner. This lease does not lock independently attached external terminals; unexpected screen changes require reobservation and may invalidate the planned action. A screen-version check cannot make arbitrary external terminal input atomic.

Record the agent's observation reference, intended action, submitted input and observed result. Do not label a keypress as a successful approval until the resulting transition is observed. Automatic approval uses the user's configured review policy; it never defaults to selecting a persistent “always allow” option.

## 9. Provider integrations and approvals

Claude integration may use native hooks for submitted prompts, tool lifecycle and permission requests alongside conversation logs. Codex integration uses its supported native records/events where available. Exact installed-version support, timing, configuration activation and hook timeout behavior require validation; neither plugin may infer support solely from a provider name.

When a structured permission hook is supported, route the request to Whim's reviewer and return the supported decision. Preserve request identity and distinguish one-time approval from a persistent rule. Pending requests need expiry/cancellation semantics. If Whim is unreachable, use a documented native fallback that does not silently grant permission; a hook timeout cannot be presented as successful review.

Hooks do not cover every menu, and installing a hook does not retroactively capture an already-open prompt. Terminal observation and key control remain available for such interactions within the user's authorization. No ACP adapter is required for either route.

## 10. Module and process boundaries

Keep packages focused and avoid one package per transport detail.

- Core owns environment and terminal contracts, shared commands, input ownership, event ingestion, persistence, synchronization and managed file transfer.
- A terminal feature plugin supplies the page and agent-facing terminal tools through those contracts.
- Claude and Codex integration plugins own native discovery, parsing, hook configuration and provider-specific status correlation. Core contains no native transcript heuristics.
- The machine-side helper is a separate executable entry point reusing collection contracts and implementations; packaging is decided with deployment, not by duplicating the logic.

Renderer accesses typed application services, never arbitrary SSH, filesystem or SQL. Backend uses asynchronous process and network I/O. The existing DB worker remains the only owner of synchronous SQLite access. tmux, native CLIs and the helper have independent lifecycles; plugins do not each require a thread.

Every stream, subprocess and subscription has an owner and cleanup path. Bound output queues, recording size and render updates. Parser faults or excessive output must not freeze the desktop. Diagnostic traces include operation/correlation IDs and timings, not raw terminal or conversation content.

## 11. Delivery and acceptance

Implement in vertical slices, validating actual Electron and ECS behavior before claiming continuity.

1. **Native terminal and attachment:** local PTY rendering, SSH, tmux inventory and live attachment. Validate IME, paste, resize, alternate screen and Ctrl+C. Attach during a long task and confirm the original execution survives.
2. **Session lifecycle:** separate detach/interrupt/terminate, stale status and reconnect. Force-kill the desktop and break SSH; check original execution identity rather than only the conversation ID.
3. **Structured recording:** implement native log collection and identity mapping per provider. Verify submitted input from Whim and another attached terminal, partial log writes, deduplication and historical import.
4. **Disconnected collection:** independently hosted helper, bounded spool, commit-before-ack and catch-up. Test collector restart, disk limits, duplicate delivery and gaps.
5. **Whim-agent operation:** observation and key/text tools, user takeover and result verification. Exercise approval menus and interrupted observations while a human also interacts.
6. **Enhancements:** validated approval hooks, attachments, remote file links, notifications and richer history presentation. Keep unsupported native behavior available through the terminal.

Acceptance must separately cover page changes, client crash, SSH loss, helper crash, agent crash and host reboot. Test uncertain input delivery without duplicate prompts. No screenshot, mocked terminal or restored transcript alone proves same-execution attachment.
