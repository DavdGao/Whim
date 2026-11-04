# Whim

Created to please myself and make everyday life a little less boring.

## Run locally

Whim runs as a macOS Electron application. Install Node.js 24 or later and pnpm 11.11.0
(the version pinned in `package.json`). Native SQLite compilation may also require Python 3
and Xcode Command Line Tools, which you can install with `xcode-select --install`.

From the repository root, install dependencies and start the application:

```sh
pnpm install --frozen-lockfile
pnpm start
```

`pnpm start` builds the workspace packages and launches the desktop app. On first launch,
it also prepares the SQLite native module for Electron; this step may require network
access and take longer than subsequent launches.

If the Electron binary was not downloaded during dependency installation, install it
explicitly, then start again:

```sh
pnpm --filter @whimkit/desktop setup
pnpm start
```

In the app, open **Settings**, enter a DashScope API key for the Beijing endpoint, and
click **Save key**. The key is stored in macOS Keychain. Choose a model that your account
can access, then create a **New conversation** and send a message. Use the sidebar's
**Language** selector to switch between English and Simplified Chinese.

After changing source code, quit the app and run `pnpm start` again to rebuild. To launch
an existing build without rebuilding, run `pnpm --filter @whimkit/desktop start`.

## Development checks

Run the workspace's formatting, lint, build, typecheck, and test checks with:

```sh
pnpm check
```

See [the runtime documentation](docs/runtime.md) for implementation coverage and verification
limits, and [the application design](docs/design.md) for the architecture.
