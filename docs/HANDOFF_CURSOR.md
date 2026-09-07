# Frontend handoff (Engineer B)

Owner: frontend / workspace UI under `src/`.

This commit implements the v0.1–v0.4 application shell. It does **not** implement PTY internals or Git command execution.

## UI architecture

Compact dark IDE chrome (not a marketing dashboard):

- Top bar: project name / path / branch, Open Project, + Terminal, + Agent, Git panel toggle
- Left sidebar: running agents
- Center: resizable terminal panes (`react-resizable-panels` v4 `Group` / `Panel` / `Separator`)
- Bottom: Git/review panel when toggled
- Status bar: branch + path

Entry: `src/main.tsx` → `src/App.tsx` → `src/components/AppShell.tsx`.

## Terminal registry

`src/terminal/registry.ts` holds `Map<terminalId, { terminal, fit, host }>`.

- xterm instances are **not** stored in Zustand
- React panes attach/detach the existing host DOM node
- Layout splits/unmounts do not dispose the PTY-facing terminal
- Hidden holding tank (`#xterm-holding`) keeps detached hosts alive
- `src/terminal/ptyBridge.ts` listens once for `pty-output` / `pty-exit` / `pty-error`

Input path: xterm `onData` → `pty_write`. Output path: backend event → `registry.write`. No fake PTY data is generated.

## Zustand stores

IDs + serializable metadata only:

| Store | File | Contents |
| --- | --- | --- |
| project | `src/stores/projectStore.ts` | `ProjectInfo`, open/validate |
| agents | `src/stores/agentStore.ts` | agents, providers, launch |
| layout | `src/stores/layoutStore.ts` | pane tree, active pane, git panel |
| terminals | `src/stores/terminalStore.ts` | `TerminalSession` records |
| git | `src/stores/gitStore.ts` | status/diff/commit/merge/discard |
| ui | `src/stores/uiStore.ts` | dialog open flags |

Pane tree helpers: `src/stores/paneTree.ts`.

## Tauri wrappers

All `invoke` calls go through `src/tauri/`. Components do not call `invoke()` directly.

| Module | File |
| --- | --- |
| IPC helper | `src/tauri/invoke.ts` |
| project / folder picker | `src/tauri/project.ts` |
| git | `src/tauri/git.ts` |
| PTY | `src/tauri/terminal.ts` |
| agents | `src/tauri/agents.ts` |

Shared TS contracts: `src/types/models.ts`, command names: `src/types/commands.ts`.

## Expected backend APIs

### Git (implemented in `src-tauri/src/git/commands.rs` — wrappers match these payloads)

- `git_validate_repository({ path })` → `RepositoryInfo`
- `git_create_worktree({ request: { repositoryRoot, provider, baseBranch? } })`
- `git_list_worktrees({ repositoryRoot })`
- `git_remove_worktree({ request: { repositoryRoot, worktreePath, force } })`
- `git_delete_branch({ request: { repositoryRoot, branch, force } })`
- `git_status({ worktreePath })` → `GitStatus`
- `git_diff({ worktreePath, filePath })` → `FileDiff[]`
- `git_commit({ request: { worktreePath, message, stageAll } })`
- `git_merge({ request: { repositoryRoot, sourceBranch, targetBranch? } })` → `MergeOutcome`
- `git_abort_merge({ repositoryRoot })`

Serde is `camelCase`. `GitError` is tagged `{ kind, details }`. `MergeOutcome` is tagged `{ outcome: "success" | "conflict", ... }`.

### PTY (manager exists in `src-tauri/src/pty/manager.rs`; commands not yet registered in `lib.rs`)

Rust session type:

```
TerminalSession { id, cwd, status }  // status: running | exited | killed | failed
TerminalOutputEvent { terminalId, data }
TerminalStatusEvent { terminalId, status }
```

Frontend calls (update `src/types/commands.ts` if Engineer A registers different names):

- `pty_create({ cwd, cols, rows, title?, argv? })` → `TerminalSession`
- `pty_write({ id, data })`
- `pty_resize({ id, cols, rows })`
- `pty_close({ id })` with fallback `pty_kill({ id })` (manager method is `kill`)

Events listened:

- `pty-output` / `terminal-output` `{ terminalId | id, data }`
- `pty-status` / `terminal-status` `{ terminalId, status }`
- `pty-exit`, `pty-error`

If these commands are missing, panes show a structured error. They never synthesize terminal output.

### Agents (`src-tauri/src/agents/mod.rs`)

Detection function: `detect_providers()`. Provider ids: **`claude`**, **`codex`**, **`cursor`** (aliases `claude-code` / `cursor-agent` accepted by `provider_spec`). Frontend catalog uses those ids; Git worktree creation maps `claude`→`claude-code`, `cursor`→`cursor-agent`.

Commands expected:

- `list_agent_providers` (fallback `detect_providers`)
- `launch_agent({ name, provider, cwd, createWorktree, cols?, rows? })` → `Agent`
- `stop_agent({ id })`
- `list_agents` → `Agent[]`

If `launch_agent` is missing, the UI **composes** `git_create_worktree` (when isolation is checked) + `pty_create`. Installed flags come only from detection. `shell` is labeled `local`, not installed.

### Dialog plugin

Open Project uses `@tauri-apps/plugin-dialog`. The Rust side does not yet register `tauri-plugin-dialog`. If the picker fails, a path-entry dialog is shown. Paths with spaces are passed as a single string.

Please add the dialog plugin + capability when convenient. Suggested window size ≥ 1280×720 (`src-tauri/tauri.conf.json` is currently 800×600).

## Git review UX

Changed-files panel is scoped to the selected agent’s `worktreePath` (else `cwd`, else project path).

- Refresh → `git_status`
- File click → `git_diff` → unified `DiffViewer` (headers / hunks / add / del / context)
- Commit → explicit message dialog, optional `stageAll`
- Merge → source = agent branch, target = project `baseBranch` (editable). Conflicts shown in-panel with **Abort merge**
- Discard → **blocked** unless the agent has an isolated worktree that is not the repo root. Confirmation requires typing `discard`, then `git_remove_worktree({ force: true })` and `git_delete_branch({ force: true })`. Main working trees are never discarded from this UI.

## Tests / checks performed

- `npx tsc --noEmit` — pass
- `npx eslint src` — pass
- `npx vite build` — pass (xterm bundle >500 kB warning only)

Did not run `tauri build` (would compile Rust owned by other engineers). Did not execute Git or PTY commands.

## Known integration issues

1. **PTY backend not wired.** `pty_*` commands and events are the contract; UI degrades to error/empty panes until Engineer A registers them. If command names differ, update `src/types/commands.ts` only.
2. **Agent provider detection missing.** Claude/Codex/Cursor stay `unavailable` until `list_agent_providers` exists.
3. **Dialog plugin missing.** Folder picker falls back to manual path.
4. **`greet` still registered** in `lib.rs` (template). Frontend no longer calls it.
5. **War Room MCP tools were not available** in this Cursor session (`war_room.list_peers` could not be invoked).
6. **Discard** maps to worktree removal, not `git reset --hard`, matching the Git backend’s safety model.
7. xterm hosts survive React StrictMode remounts via attach/detach; dispose only happens when a pane’s session is closed.

## Files owned by this work

Primarily `src/**`, plus frontend toolchain: `package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig*.json`, `eslint.config.js`, `index.html`, `docs/HANDOFF_CURSOR.md`.

`src-tauri/` was inspected and left unchanged.
