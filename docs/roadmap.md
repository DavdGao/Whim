# Implementation Roadmap

This file is the working task list for the rebuild started from `main` on 2026-11-04. Earlier implementation on `main` is not authoritative: any of it may be replaced. Check a box only when the change is merged with its acceptance checks actually run; note live or Electron checks that could not run.

Each PR updates [design.md](design.md) / [agent.md](agent.md) before or together with its implementation.

## PR 1 — Design rewrite (docs only)

- [ ] Research and record sources with verification dates
    - [ ] agentscope credential, HintBlock, ToolBase, PermissionRule designs
    - [ ] DashScope official docs: auth, regions/endpoints, Responses vs Chat Completions coverage, thinking parameters, native tools (web search/fetch, code), PDF/file and video input, error codes, usage fields
- [ ] Plugin system: package manifest, host/client entries, activation, registration scopes, rollback, dispose, install records (id, version, installed-at, source, content hash), integrity check on start
- [ ] Credential layer: plugin-declared credential types (JSON Schema), user-created credential instances, Keychain for `writeOnly` secrets, adapters declaring accepted credential types
- [ ] Model slots: main chat, compaction, decision, tts, asr, embedding as `{ credentialId, cardId }`
- [ ] Model card v2: core fields (`kind`, input map, `output: string[]`, thinking object with fixed `off|low|medium|high|max` vocabulary and `fixed` flag, limits, `nativeTools`) plus plugin-validated `options`
- [ ] Card catalog layering: bundled seed → optional remote catalog (later) as read-only upstream layer; user overrides and user-created cards as a separate layer; effective card = merge; invalid cards surface as errors without crashing
- [ ] Shared OpenAI-compatible protocol library decision (not in core; see PR 1 notes)
- [ ] JSON Schema conventions: 2020-12, `writeOnly` + `format: "password"` for secrets, a small documented set of `x-whim-*` extension keywords (e.g. i18n keys)
- [ ] Agent journal record catalogue and ownership (messages, deliveries, consumption/plan, attempts, tool jobs, interruption, compaction, source revisions, usage)
- [ ] Notice block: discriminated `kind`, structured `origin`, typed payload, multimodal content, `observedAt`; rendered as `<system-reminder>` by a versioned core renderer; display left to frontend
- [ ] Generic context-source mechanism for every prefix-affecting input (system sections, skill catalog, MEMORY.md, tool schemas): revisions by hash, epoch snapshot with timestamps, delta notices, refresh only at compaction; leave room for dynamic tools/tool search on providers without native support
- [ ] Interruption, errors (`category`, discriminated `retry`, `outcome`, provider `detail` passthrough), retry scheduling and UI states
- [ ] Admission before acceptance, tool-result truncation/offload, auto-compaction thresholds, crash recovery and Backend supervision
- [ ] Tools: declaration (`inputSchema`, `readOnly`, `concurrencySafe`), scheduling, Job service with background handoff and JobOutput/JobStop, native vs local tool resolution
- [ ] Permissions: rules `{ tool, pattern, behavior }`, manual and auto modes, auto reviewer via structured chat or decision model
- [ ] Attachments: native routes vs core processors (PDF), isolated helper with limits
- [ ] Frontend: app shell with Chat / Models & Credentials / Plugins / Settings, shadcn components in `apps/desktop`, en/zh-CN
- [ ] Update AGENTS.md rules that change (drop `@whimkit/ui`, provider error passthrough, card/credential rules)
- [ ] Rewrite or remove runtime.md and errors.md so no document describes stale behavior

## PR 2 — Foundation and minimal chat

- [ ] Remove superseded packages/code from `main`
- [ ] models: card v2 schema, catalog loader with layering, validation errors
- [ ] core: plugin host, credential store (Keychain + DB), model slots, JSON Schema validation
- [ ] core: journal, inbox, atomic consumption, attempts, chunk batching, seq-based incremental subscription
- [ ] agent: streaming chat run, Stop and continue with interrupt notice, retries with durable scheduling, admission before acceptance
- [ ] plugin-dashscope: credential type, seed cards, chat adapter with error normalization and usage
- [ ] desktop: Main/Backend/Renderer, single-instance lock, Backend supervision, typed preload
- [ ] desktop: app shell and four pages, JSON Schema forms for credentials/settings, en/zh-CN
- [ ] Tests: real SQLite, protocol fixtures, recovery; Electron and live DashScope smoke run by the user on macOS

## PR 3 — Context

- [ ] Compaction records, epochs, UI feedback
- [ ] Context-source tracking and notices
- [ ] Skills
- [ ] MEMORY.md plugin

## PR 4 — Tools

- [ ] Bash, Grep (ripgrep), Glob, Read, Edit, Write
- [ ] Concurrent/serial scheduling, Job service, background handoff, JobOutput/JobStop
- [ ] Truncation and offload
- [ ] Permissions (manual, auto)
- [ ] Native tool resolution (web search/fetch) and PDF processor

## Later

- [ ] Remote card catalog refresh
- [ ] Dynamic tools / tool search via the context-source mechanism
- [ ] TTS/ASR/embedding slots, forks, other product capabilities
