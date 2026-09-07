# PTY and Agent Runtime Design

## Scope

This subsystem provides the Rust backend for real interactive terminal and coding-agent sessions in the Tauri 2 desktop application. It owns PTY creation, process lifecycle, shell selection, installed CLI discovery, and constrained agent launching. It does not provide Git worktree or Git review operations.

## Architecture

`PtyManager` owns a thread-safe map keyed by UUID terminal IDs. Each entry contains one portable-pty master, the child process, and a shutdown signal. Creating a terminal opens a native PTY, spawns the selected shell with an explicit working directory, and starts a reader thread. The reader thread emits `terminal-output` events carrying the session ID and UTF-8-safe output chunks.

Tauri commands expose only structured operations: create, write, resize, and kill terminal sessions; list detected agent providers; and launch a selected provider with a validated working directory. No frontend command accepts an arbitrary shell command string. Shell and agent detection search PATH directly, including Windows PATHEXT and PowerShell script shims, and preserve paths as `OsString`/`PathBuf` values until process spawning.

## Contracts

Terminal commands use serializable request/response structures:

- `pty_create(cwd, cols, rows) -> TerminalSession { id, cwd, status }` (also registered as `create_terminal`)
- `pty_write(id, data) -> ()` (also registered as `write_terminal`)
- `pty_resize(id, cols, rows) -> ()` (also registered as `resize_terminal`)
- `pty_close(id) -> ()` (also registered as `kill_terminal`)
- `list_agent_providers() -> Vec<AgentProvider>`
- `launch_agent(provider, cwd) -> Agent { terminalId, status, ... }`

Terminal output is a `pty-output` application event with `{ id, data }`. Normal and killed lifecycle changes are `pty-exit` events with `{ id, exitCode }`; reader failures are `pty-error` events with `{ id, message }`. This matches the existing frontend bridge while allowing independent sessions to transition to `exited`, `killed`, or `failed` internally.

## Error and cleanup policy

Invalid UUIDs, missing sessions, invalid dimensions, unavailable executables, invalid working directories, and PTY I/O failures return structured command errors. Killing a session removes only its map entry, signals its reader, closes the PTY master, and waits for the child where supported. A reader detecting EOF removes its own session only if it is still the current entry, preventing a stale thread from affecting a replacement session.

## Testing strategy

Unit tests cover provider metadata and executable candidate selection. Integration tests create two real PTYs, verify independent output and resize calls, kill one without killing the other, and run `git status` through a shell PTY. Environment-dependent coding CLI tests report skipped when no supported CLI is installed. Cargo format, check, clippy, and test commands are the release gates.
