# ZLI

ZLI is an Electron desktop workspace for coding agents. It provides isolated Git worktrees, persistent terminal sessions, structured Codex sessions, Git review, and a Chromium browser scoped to each worktree.

## Requirements

- Node.js 24
- Corepack with pnpm 10.14.0
- Git

Enable pnpm and install the workspace dependencies:

```sh
corepack enable
pnpm --dir v2 install --frozen-lockfile
```

## Run and verify

The root scripts forward to the pnpm workspace in [`v2/`](v2/):

```sh
npm run dev
npm run verify
npm run build
npm run desktop:dir
npm run desktop:pack
```

`npm run dev` builds and starts the Electron desktop. `npm run verify` checks import boundaries, formatting, lint, unit tests, and types. `npm run desktop:dir` creates an unpacked application for local testing, and `npm run desktop:pack` creates a platform installer.

The packaged Electron journeys run only when `ZLI_RUN_E2E` is set.

Bash:

```sh
ZLI_RUN_E2E=1 npm run e2e
```

PowerShell:

```powershell
$env:ZLI_RUN_E2E = "1"
npm run e2e
```

On Linux without a display, run the journeys under `xvfb-run -a`.

## Architecture and attribution

The application lives in [`v2/`](v2/). It uses an Electron shell, a typed renderer/runtime boundary, a durable local server, and a detached workspace daemon for terminal ownership. Its worktree, provider, browser, and recovery boundaries are informed by the pinned T3 Code and Orca references listed in [`v2/UPSTREAM_SOURCES.md`](v2/UPSTREAM_SOURCES.md). Third-party license information is in [`v2/THIRD_PARTY_NOTICES.md`](v2/THIRD_PARTY_NOTICES.md).
