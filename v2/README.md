# ZLI V2

ZLI V2 is the clean Electron rebuild. The desktop shell owns the secure window, embedded Chromium views, preload bridge, and local runtime process; the renderer communicates through typed contracts and the server owns durable projections, PTY sessions, Git worktrees/review, structured providers, and diagnostics.

## Project file: zli.json

Put a `zli.json` at the root of a repository to share worktree setup with the team. ZLI reads it from the project folder every time it creates a worktree, so edits apply to the next one without a restart.

```json
{
  "version": 1,
  "worktree": {
    "copy": [".env", "apps/web/.env.local", "config/*.local.json"],
    "setup": ["pnpm install --frozen-lockfile", "pnpm run db:migrate"]
  }
}
```

- `worktree.copy` lists files, folders, or globs, relative to the repository root, to copy from the main checkout into each new worktree. Typical use is ignored files such as `.env`. Paths must stay inside the repository: absolute paths, `..`, and `.git` are rejected, symbolic links are never copied, and a file that already exists in the worktree is left alone. Globs do not look inside `.git` or `node_modules`. At most 500 entries are copied.
- `worktree.setup` lists commands that run in order inside the new worktree, each in its own terminal in the terminal drawer (`bash -lc` on macOS and Linux, PowerShell on Windows). Setup stops at the first command that exits with a non-zero code, and the sidebar shows which command failed and its exit code.

Setup commands run with your permissions, so ZLI asks before running them. The dialog shows the exact commands and offers **Run once**, **Always run for this project**, or **Skip setup**. "Always" is remembered for that exact list of commands: if `zli.json` changes them, ZLI asks again. Until you answer, the worktree shows "Needs approval" and agents waiting for it do not start. After setup finishes, fails, or is skipped, the worktree is ready and its agents start.

An invalid `zli.json` never blocks work. ZLI creates the worktree without copying or running anything and shows the problem, naming the field that failed. A `.worktreeinclude` file is still honored and is applied before `zli.json`.
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
