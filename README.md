# ZLI

ZLI is a Windows desktop workspace for running multiple coding agents in isolated Git worktrees. It combines terminal panes, agent attention states, resumable project sessions, TaxChat, Git review, and an agent-controlled browser.

## Run locally

Install Node.js, Rust, and the Tauri Windows prerequisites. Then run:

```powershell
npm install
npm run tauri dev
```

Use `npm run tauri dev`, not `npm run dev`: the latter starts only the web frontend and cannot provide terminals, worktrees, the local API, or the WebView2 browser surface. The Tauri command also builds the development `zli.exe` used by managed agents.

## Verify and package

```powershell
npm test
npm run lint
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build
```

The release wrapper builds `zli` for the current Rust target, names it using Tauri's target-triple convention, and includes it beside the desktop executable. Managed child agents receive its absolute path as `ZLI_COMMAND`, and its directory is prepended to their `PATH`.
