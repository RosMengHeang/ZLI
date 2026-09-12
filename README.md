# ZLI

ZLI is a Windows desktop workspace for running multiple coding agents in isolated Git worktrees. It combines terminal panes, agent attention states, resumable project sessions, TaxChat, Git review, and an agent-controlled browser.

## Run locally

Install Node.js, Rust, and the Tauri Windows prerequisites. Then run:

```powershell
npm install
npm run tauri dev
```

Use `npm run tauri dev`, not `npm run dev`: the latter starts only the web frontend and cannot provide terminals, worktrees, the local API, or the WebView2 browser surface. The Tauri command also builds the development `zli.exe` and `zli-browser-use.exe` used by managed agents.

## Verify and package

```powershell
npm test
npm run lint
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build
```

The release wrapper builds `zli` and `zli-browser-use` for the current Rust target, names both using Tauri's target-triple convention, and includes them with the desktop bundle. All ZLI-managed agent sessions receive the scoped CLI and Browser Use adapter paths through their environment, and the directory is prepended to their `PATH`.

## Local control API

With ZLI running, the bundled `zli` command talks to the current desktop session through its authenticated local control pipe:

```powershell
zli health
zli health --project D:\path\to\repo
zli status
zli agents
zli attention
zli agent queue --project D:\path\to\repo
zli agent send <agent-id> "Run the focused tests"
zli session resume <session-id>
zli browser status
zli browser doctor --agent <agent-id>
zli browser snapshot <surface-id>
zli taxchat send "Review the release" --project D:\path\to\repo
```

Add `--json` for machine-readable output. `zli health` is read-only: it reports session counts, active and reserved agent capacity, event replay state, and whether durable event persistence is healthy. `zli doctor` and `zli session reconcile` remain the explicit recovery commands and may change runtime ownership state.

## Built-in browser control

The browser is a Tauri WebView2 pane owned by ZLI, not a connection to the user's Chrome profile. A new clean profile starts with `Enable built-in browser control` enabled in Preferences. `zli browser status` checks the authenticated desktop bridge; `zli browser doctor --agent <agent-id>` reports the scoped profile, CLI fallback, Browser Use adapter, and provider MCP configuration without exposing credentials.

All ZLI-managed agents receive `ZLI_BROWSER_PROFILE`, `ZLI_BROWSER_SESSION`, and `ZLI_BROWSER_USE_COMMAND`. Providers with an accepted MCP launch configuration can use the provider-neutral `zli-browser-use` adapter; all managed sessions have the scoped `zli browser ...` fallback. ZLI reports unsupported or fallback providers honestly instead of assuming every CLI can discover MCP from a prompt.

Support status is per capability, not per install. See [`docs/testing/zli-provider-feature-matrix.md`](docs/testing/zli-provider-feature-matrix.md) for verified, partial, unsupported, and not-tested cells from unit evidence. Live desktop and packaged Windows checks are recorded only when run; see [`docs/testing/zli-wp8-evidence.md`](docs/testing/zli-wp8-evidence.md). Local browser fixture pages live under [`docs/testing/fixtures/browser-site/`](docs/testing/fixtures/browser-site/).
