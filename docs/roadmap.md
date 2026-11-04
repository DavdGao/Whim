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
- [ ] Load history in bounded pages instead of the whole session
- [ ] Validate IPC results in Renderer with schemas, not only envelopes
- [ ] Warn about unreadable attachments before a model switch (with attachments)
- [ ] Verify seed card limits and per-model thinking levels

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
- [ ] Data a plugin produced (records, settings, files) loses its consumer when the plugin is removed; define ownership so removal cannot leave errors or polluted state
- [ ] Dynamic tools / tool search (design not started; the context-source mechanism stays general enough to host it)
- [ ] TTS/ASR/embedding slots, forks, other product capabilities
