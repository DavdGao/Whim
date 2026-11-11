# Implementation Roadmap

This file is the working task list for the rebuild started from `main` on 2026-11-04. Earlier implementation on `main` is not authoritative: any of it may be replaced. Check a box only when the change is merged with its acceptance checks actually run; note live or Electron checks that could not run.

Each PR updates [design.md](design.md) / [agent.md](agent.md) before or together with its implementation.

## PR 1 — Design rewrite (done)

- [x] Plugin system, credential layer, model slots, card v2, catalog layers, JSON Schema conventions
- [x] Agent records, notices, context sources, interruption, errors and retries, compaction, tools, permissions
- [x] Frontend shell, AGENTS.md rules, DashScope provider notes; stale runtime.md and errors.md removed

## PR 2 — Foundation and minimal chat (done)

- [x] Remove superseded packages
- [x] core: card v2 schema, layered catalog with merge patches and per-entry validation errors
- [x] core: plugin host (manifest, install records, integrity hash, scoped activation and rollback, locales), credentials with `safeStorage` ciphertext, JSON Schema validation
- [x] core: `node:sqlite` journal in a DB worker, idempotent commands, inbox, atomic step consumption, recovery projection
- [x] agent: streaming run, transient deltas with one commit per attempt, Stop with verbatim partial answer and interrupt notice, retries with durable scheduling (including after partial output), restart notice, input budget check
- [x] plugin-dashscope: credential type, Responses adapter, error mapping, seed cards
- [x] desktop: Main/Backend/Renderer, single-instance lock, Backend restart with backoff, sequence-based incremental updates, Chat/Models/Plugins/Settings pages, en/zh-CN, `pnpm app`
- [x] Verified on Linux under Xvfb against a mock Responses server: credential form, 401 detail, streaming, Stop and continue, quit mid-stream and restart, language switch

## PR 2 follow-ups

- [ ] Run on macOS and against live DashScope; verify Keychain-backed `safeStorage`
- [ ] Live plugin disable/removal sequence (design.md §5.4); today enabling/disabling applies after restart
- [ ] Credential "Test" action (`verify`)
- [x] Load history in bounded pages (60 entries) instead of the whole session; older pages load when the transcript is pulled past its top, without a button
- [ ] Validate IPC results in Renderer with schemas, not only envelopes
- [ ] Warn about unreadable attachments before a model switch (with attachments)
- [ ] Verify seed card limits and per-model thinking levels

## PR 3 — Frontend design pass

- [x] Sidebar holds the Whim logo and name; Settings at the bottom; title strip only for dragging, the sidebar toggle, and connection status
- [x] Consumer design rules (design.md §11.3): large radius, icon on every button, primary/ghost roles, busy state for business actions (`ActionButton`, `useAction`), fixed dialog footer, `ChoiceMenu` instead of shadcn `Select` (lint-enforced), no internal vocabulary in visible text
- [x] Plugin `icon`/`icons` manifest fields and card `icon` key; DashScope ships Bailian and Qwen icons
- [x] LaTeX in answers (Streamdown math plugin, KaTeX), including `\(…\)` and `\[…\]`
- [x] Copy action on answers (AI Elements `MessageActions`)
- [x] Verified on Linux under Xvfb: credential dialog, model and thinking menus, math rendering, language switch, collapsed sidebar

## Frontend feedback round 2

- [x] Chat list: Pinned / Today / Earlier groups, time on the right, hover menu with rename, pin, delete
- [x] Settings with a section list: General, Agent (name, icon, system prompt), Models (list and Bailian-style detail), Plugins grouped by manifest `category`
- [x] One model button with grouped models and a draggable thinking-level track; context usage ring with breakdown
- [x] Answers take the full width
- [ ] Show the chat's token total (recorded, including tool-internal calls); presentation to be decided
- [ ] Model kinds beyond chat (Decision, TTS) as groups in Settings → Models when they exist

## PR 4 — Attachments

- [x] Per-session media store (content-addressed, immutable), admission from card `input` at send, `file:` URI references
- [x] DashScope delivery of images (Qwen3.8 Max, DeepSeek V4.1 Flash, Kimi K3.1 Pro); text files inline; `<data>` references for unreadable media
- [x] Composer attachments from the + menu, drag and drop, and paste; per-attachment errors; images in messages and tool results
- [x] Multimodal tool results: `Read` returns images; promoted after all results unless the adapter carries them in tool results
- [ ] PDF through a processor with page and byte limits
- [ ] Verify whether DashScope accepts images inside `function_call_output` and declare `toolResultMedia` if so

## PR 5 — Context

- [x] Automatic compaction (no manual trigger): records, epochs, transcript offload with media references, summary with the session's model, UI line with the summary
- [x] Compact and retry once when the provider reports `context-limit` despite the estimate
- [x] Compaction rework, part A (agent.md §8):
    - Summary asked in the step's own request (same system prompt, tools, thinking, and history, cut before the kept tail) with a trailing reminder carrying the current time; tool calls not allowed
    - Tagged summary (`goal`, `current-state`, `progress`, `findings`, `next-steps`) with rules against copying the previous summary, for corrections, verbatim identifiers, absolute times, and pending items; escaped tags parsed; asked once more when a section is missing, a tool was called, or the reply hit the output limit; the second reply kept as written; each request recorded as `compaction.attempted` with its usage
    - The last six entries (fewer when large) stay verbatim instead of everything after the latest input, never separating a call from its results, so a long autonomous run compacts; the latest user message stays verbatim; up to three compactions per step
    - A refused summary request summarizes the older half; a single covered entry has its longest texts shortened in the middle, halving until accepted
    - `output-limit` failure category, so a reply cut at the output limit no longer triggers compaction
- [x] One conversation file per session (`conversation.md`) instead of chained per-compaction files: only the conversation's flow, no summaries; each message, tool result and notice tagged with its sequence number and time (`<user seq time>`, `<tool_result call_id name status>`, `<notice kind>`), thinking and tool calls included; rendered whole from the journal and renamed into place at each compaction, so a crash leaves no gap or repeat; renderer version 2
- [ ] Compaction rework, part B:
    - Rendered summary followed by sections from local facts, each omitted when empty and naming only tools the session has: conversation file with Read/Grep guidance, running background jobs, recent user messages, recently read or written files; a task list once plans exist
    - Optional structured `parts` in the epoch context (old string summaries still decode); the compaction line shows the parts
- [ ] Verify the summary request's prefix cache hit against live DashScope
- [ ] Context-source tracking and notices
- [ ] Skills
- [ ] MEMORY.md plugin

## PR 6 — Tools

- [x] Foundation: tool definitions and plugin registration, `tool_call`/`native_tool_call` blocks, tool results, permission/tool/job records, epoch tool sets, session workspace
- [x] Tool runtime: validation, scheduling (parallel safe groups, per-workspace lock), jobs with background handoff, `JobOutput`/`JobStop`, offload above 32 KiB, recovery of lost calls and jobs
- [x] Manual permissions with session grants; Tool and Confirmation display in chat
- [x] Responses function calling; DashScope native `web_search`/`web_extractor`
- [x] `@whimkit/tools` (base tools, part of the harness): Bash, Read, Write, Edit, Glob, Grep (ripgrep via `@vscode/ripgrep`), local WebFetch
- [x] Default working folder so every new chat has the base tools: the session's own `workspace/` (formerly `~/Whim`), described with the session folder in the system prompt
- [x] Local WebSearch through Tavily (a plugin with an API-key credential), for models without provider search; scraping a search engine's HTML was dropped because it is challenged as a bot and goes against the engine's intent
- [x] macOS packaging with electron-builder (design.md §13.1); the ripgrep binary is unpacked outside the asar archive, verified by running Grep in a packaged build (Linux `dir` target, same archive layout)
- [ ] Build and run the arm64 and x64 apps on a Mac
- [ ] Signing and notarization in the release pipeline
- [ ] Live DashScope check of function calling with thinking models (reasoning item replay)
- [x] Auto mode: a reviewer (Chat with a `decide` tool, or a Decision model) answers asks first, falling back to the user; recorded with usage
- [x] Decision provider plugin (TypeSafe System One): `typesafe/jev`, verified against the OpenAPI contract with fixtures and a mock server
- [ ] Live TypeSafe check once an account is available
- [ ] Persistent permission rules in Settings, with a Bash parser that matches each simple command of a compound one

## PR 7 — Background operation (design.md §4.1)

- [x] Menu bar item with running and waiting chats, Open Whim, and Quit Whim; quit asks while chats run; closing the window keeps Whim running (verified in Electron under Xvfb; the menu bar itself still to be seen on a Mac)
- [x] Notifications for finished, failed, and waiting chats while no window is focused; clicking opens the chat
- [x] Hold `prevent-app-suspension` while chats run
- [ ] Launch at login without opening a window; optional Dock icon hiding
- [ ] Schedules and triggers (design.md §4.1.1)

## PR 8 — Plugin API (design.md §5.7)

- [x] Plugin API version (`whim.api`) and declared contributions (`whim.contributes`), shown on the Plugins page; undeclared registrations fail activation
- [x] Host services and plugin methods/topics over the Renderer port
- [x] Navigation rail and settings tabs from one registry; shadcn and AI Elements moved into `@whimkit/ui`
- [x] Client entries: `whim-plugin://` protocol, import map for shared modules, slots `page`, `settings.section`, `chat.tool`, `composer.action`, verified with a fixture plugin in Electron
- [x] Local plugins under `<userData>/plugins/`, disabled until the user enables them
- [x] Declarative themes: token sets and a background image, chosen in Settings → General

## PR 9 — Coding page (design.md §11.4)

- [x] Core: tmux commands for this Mac and SSH hosts (shared `ControlMaster` connection), PTY terminals with acknowledgment-based flow control, tested against a real tmux server
- [x] Plugin API 1.1: `codingAgents` contribution; Claude Code and Codex plugins
- [x] Coding page: computer picker with SSH hosts, session list, new session with agent and folder, xterm.js terminal with reconnect, end session
- [x] Fix SSH on macOS: quote `ControlPath` (the data folder has a space) and keep sockets in a short private `/tmp/whim-<uid>` so they fit `sun_path`
- [x] Terminal fills its panel; fixed dark palette, and a matching tmux status line for sessions Whim starts
- [ ] Verify an SSH host end to end (listing, start, attach, a broken connection)
- [x] Fix `posix_spawnp failed` on macOS: `node-pty` 1.1.0 ships `spawn-helper` without the execute bit; pinned to 1.2.0-beta.18
- [ ] Run on a Mac: packaged `node-pty`, IME, paste, Ctrl+C, alternate screen
- [ ] Session lifecycle, recording, and Whim-agent control (coding-agents.md §11 slices 2–5)

## Later

- [ ] Remote card catalog refresh
- [ ] Data a plugin produced (records, settings, files) loses its consumer when the plugin is removed; define ownership so removal cannot leave errors or polluted state
- [ ] Dynamic tools / tool search (design not started; the context-source mechanism stays general enough to host it)
- [ ] TTS/ASR/embedding slots, forks, other product capabilities
