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
- `worktree.setup` lists commands that run in order inside the new worktree, each in its own terminal in the terminal drawer (`bash -lc` on macOS and Linux, `cmd.exe` on Windows, the same shell npm scripts use). Setup stops at the first command that exits with a non-zero code, and the sidebar shows which command failed and its exit code.

Setup commands run with your permissions, so ZLI asks before running them. The dialog shows the exact commands and offers **Run once**, **Always run for this project**, or **Skip setup**. "Always" is remembered for that exact list of commands: if `zli.json` changes them, ZLI asks again. Until you answer, the worktree shows "Needs approval" and agents waiting for it do not start. After setup finishes, fails, or is skipped, the worktree is ready and its agents start.

An invalid `zli.json` never blocks work. ZLI creates the worktree without copying or running anything and shows the problem, naming the field that failed. A `.worktreeinclude` file is still honored and is applied before `zli.json`.

### Saved prompts

`zli.json` can also share prompts with the team:

```json
{
  "version": 1,
  "prompts": [{ "name": "Review checklist", "prompt": "Review the diff for missing tests and unclear names." }]
}
```

Type `/` at the start of a message to pick one: the list narrows as you type, arrows move, Enter inserts it. The bookmark button next to the message box opens the same list. Prompts you keep for yourself are saved on this computer under **Saved prompts** in the command palette, where you can add, edit, and delete them; the prompts from `zli.json` are shown there read-only.

## Best of N

Best of N sends one message to several agents at once, each in its own worktree, so you can compare what they did and keep one.

- **Send as Best of N**: type a message, then open the menu on the Send button (the chevron) or press Ctrl+Shift+Enter (Cmd+Shift+Enter on macOS). Pick 2, 3, or 4 runs (3 by default) and, if you like, a different agent or model per run; every run starts as the chat's own agent and model. **Start runs** creates one worktree per run from the chat's worktree as it is now, including uncommitted changes, and sends the message to each.
- **Try N ways**: hover a message you already sent and pick **Try N ways**. The runs start from the files as they were before that message, then send it again.

Each run gets a branch named after the chat's branch, `<branch>-run1` to `<branch>-runN` (with a number added if those names are taken). In the sidebar the runs are listed under the chat they came from, with a Run badge and a live Running, Done, or Failed status. When every run has finished, the group shows **Compare** and a notice appears.

Compare shows the runs side by side: agent and model, status, files changed with added and removed lines, the checks the agent ran (tests, lint, type checks), cost when the agent reports it, and time. **View diff** opens that run's changes. **Keep this one** asks once, then deletes the other runs together with their worktree folders and branches, including uncommitted changes and commits that exist only there. The kept run becomes an ordinary chat.

## ZLI Mobile

The Mobile panel (Mod+Shift+M) shows Android emulators, Android phones over USB, and, on a Mac with Xcode, iOS simulators. You can boot them, watch the screen, and tap, swipe, scroll, and type. Agents drive the same devices through the zli-mobile tool, and the panel shows who holds each device. On Windows and Linux, Android is the only platform; the panel can download and set up the Android emulator for you.

Unit tests use fake drivers. The checks that need real hardware are in [apps/web/src/mobile/MANUAL_TEST.md](apps/web/src/mobile/MANUAL_TEST.md).
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
