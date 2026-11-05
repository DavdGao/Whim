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
- [ ] Compact and retry once when the provider reports `context-limit` despite the estimate
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
- [ ] Package the ripgrep binary outside the asar archive when building the macOS app
- [ ] Live DashScope check of function calling with thinking models (reasoning item replay)
- [x] Auto mode: a reviewer (Chat with a `decide` tool, or a Decision model) answers asks first, falling back to the user; recorded with usage
- [x] Decision provider plugin (TypeSafe System One): `typesafe/jev`, verified against the OpenAPI contract with fixtures and a mock server
- [ ] Live TypeSafe check once an account is available
- [ ] Persistent permission rules in Settings, with a Bash parser that matches each simple command of a compound one

## Later

- [ ] Remote card catalog refresh
- [ ] Data a plugin produced (records, settings, files) loses its consumer when the plugin is removed; define ownership so removal cannot leave errors or polluted state
- [ ] Dynamic tools / tool search (design not started; the context-source mechanism stays general enough to host it)
- [ ] TTS/ASR/embedding slots, forks, other product capabilities
