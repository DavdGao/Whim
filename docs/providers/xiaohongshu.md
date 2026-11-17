# Managed Xiaohongshu connection

Feed's **Set up and sign in** action installs and enables the connector, then requests a QR code. Users scan with the Xiaohongshu app; no password, URL or headers are required. The account belongs to the shared `xiaohongshu` server, including when several source agents use it.

The plugin pins [xiaohongshu-mcp v2.7.4](https://github.com/xpzouying/xiaohongshu-mcp/releases/tag/v2.7.4), using the macOS arm64 asset and its release SHA-256 digest. It adds the MCP SDK already used by Core to forward the owned connector's HTTP endpoint over Core-managed stdio. Only Apple silicon is supported by this release. Core launches it through Electron's Node mode, including from packaged archives.

The [upstream entry point](https://github.com/xpzouying/xiaohongshu-mcp/blob/v2.7.4/main.go) prepares its browser before serving MCP. Its [browser installer](https://github.com/xpzouying/xiaohongshu-mcp/blob/v2.7.4/browser/browser_download.go) downloads Chromium 148.0.7778.215 from `cdn.one-world.ai`, verifies the publisher's SHA256SUMS and caches it under the user's Library/Caches. Initial preparation can take several minutes. Whim binds the service to an ephemeral loopback port with a generated bearer token; the connector retains its own cookie file in Whim's private per-server directory. Connection secrets managed by Core remain encrypted separately. Closing a Feed dialog leaves setup running; disabling the server or quitting stops the owned process group.

## Verification on November 17, 2026

The macOS arm64 Electron utility-process trial downloaded and verified the real connector and launched it through the same helper executable used by Backend. The browser download returned HTTP 403: the machine's corporate domain policy blocks `cdn.one-world.ai`. The resulting failure now identifies the download host and HTTP status without retaining connector logs or account data. Domain access must be allowed through the organization's normal network process before retrying setup.

Automated checks cover checksum and size rejection, cache reuse and repair, interrupted downloads, and stopping a real stdio process during its initial handshake. A separate Electron utility-process trial used the real pinned connector with an isolated, nonfunctional browser fixture: MCP initialization, tool discovery, disable and restart all passed through the stdio-to-HTTP bridge without accessing the blocked CDN. This establishes transport behavior only.

Electron UI checks cover keyboard submission, busy/disabled state, QR handoff using a fixture, English/Chinese text and widths from 320 to 1440 pixels. The archive smoke check confirms Electron Node mode can run a script from ASAR. A real QR scan, signed-in persistence and signed-in search remain unverified because browser preparation was blocked; fixture results do not establish them.
