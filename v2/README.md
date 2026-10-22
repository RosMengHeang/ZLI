# ZLI V2

ZLI V2 is the clean Electron rebuild. The desktop shell owns the secure window, embedded Chromium views, preload bridge, and local runtime process; the renderer communicates through typed contracts and the server owns durable projections, PTY sessions, Git worktrees/review, structured providers, and diagnostics.

## Verify locally

From this directory:

```sh
pnpm install --frozen-lockfile
pnpm run verify
pnpm run build
pnpm run desktop:pack
```

The repository currently requires Node 24. The local Electron binary must be installed by pnpm before packaging or running the Electron journeys.

## Electron journeys

The Playwright suite covers the real desktop boundary: Git worktree creation, the deterministic structured-provider harness, embedded Chromium restoration, review commit/merge, runtime-process reconnect, and legacy snapshot import.

Bash:

```sh
ZLI_RUN_E2E=1 pnpm run e2e
```

PowerShell:

```powershell
$env:ZLI_RUN_E2E = "1"
pnpm run e2e
```

The integration workflow runs these journeys on Windows, macOS, and Linux before packaging. The mock provider and test-only runtime controls are enabled only by explicit `ZLI_TEST_*` environment variables and are never used by production startup.
