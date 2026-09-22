# ZLI

ZLI is an Electron desktop workspace for coding agents. It provides isolated Git worktrees, persistent terminal sessions, structured Codex sessions, Git review, and a Chromium browser scoped to each worktree.

## Requirements

- Node.js 24
- Corepack with pnpm 10.14.0
- Git

Enable pnpm and install the V2 workspace dependencies:

```powershell
corepack enable
pnpm --dir v2 install --frozen-lockfile
```

## Run and verify

```powershell
npm run dev
npm run verify
npm run build
npm run desktop:dir
npm run desktop:pack
```

`npm run dev` starts the Electron desktop. `npm run desktop:dir` creates an unpacked application for local testing, and `npm run desktop:pack` creates a platform installer.

For the packaged Electron journeys:

```powershell
$env:ZLI_RUN_E2E = "1"
pnpm --dir v2 run e2e
```

## Legacy desktop

The previous Vite/Tauri application remains available for one transition cycle:

```powershell
npm run legacy:dev
npm run legacy:build
npm run legacy:tauri -- dev
```

## Architecture and attribution

The V2 workspace is under [`v2/`](v2/). It uses an Electron shell, a typed renderer/runtime boundary, a durable local server, and a detached workspace daemon for terminal ownership. Its worktree, provider, browser, and recovery boundaries are informed by the pinned T3 Code and Orca references listed in [`v2/UPSTREAM_SOURCES.md`](v2/UPSTREAM_SOURCES.md). Third-party license information is in [`v2/THIRD_PARTY_NOTICES.md`](v2/THIRD_PARTY_NOTICES.md).
