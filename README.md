# Whim

Created to please myself and make everyday life a little less boring.

Whim is a macOS desktop agent workspace built with Electron, TypeScript, and React. The architecture is described in [docs/design.md](docs/design.md) and [docs/agent.md](docs/agent.md); progress is tracked in [docs/roadmap.md](docs/roadmap.md).

## Build and run

Requires Node.js 24 and pnpm 11.

```sh
pnpm app
```

This installs dependencies, builds every package, and starts the desktop app. Then:

1. Open **Models**, add a DashScope credential with your API key (leave Base URL empty for the default endpoint).
2. Open **Chat** and send a message.

Other commands:

| Command                                | What it does                                    |
| -------------------------------------- | ----------------------------------------------- |
| `pnpm build`                           | Build all packages and the desktop app          |
| `pnpm check`                           | Format check, lint, build, typecheck, and tests |
| `pnpm --filter @whimkit/desktop start` | Start the app from an existing build            |

Model cards can be added or overridden as JSON files in the app's `models` directory (shown on the Models page).

## Packages

| Path                        | Purpose                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| `packages/core`             | Contracts, SQLite journal, plugin host, credentials, model catalog |
| `packages/agent`            | The run loop: streaming, interruption, retries                     |
| `packages/openai-protocol`  | Shared Responses wire types and SSE decoding                       |
| `packages/plugin-dashscope` | DashScope credential type, Responses adapter, seed cards           |
| `apps/desktop`              | Electron Main, Backend, preload, and the React renderer            |
