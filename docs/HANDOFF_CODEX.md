# Engineer A Handoff: PTY and Agent Runtime

## Scope

This handoff covers the Rust backend for v0.1 real terminals and the backend portion of v0.2 coding-agent launch. Git worktree, status, diff, commit, merge, and discard logic remains in `src-tauri/src/git/` and was not changed here.

## PTY architecture

`src-tauri/src/pty/manager.rs` contains `PtyManager`, a clonable handle around an `Arc<ManagerInner>`. `ManagerInner` owns a `Mutex<HashMap<Uuid, Arc<SessionHandle>>>`; each UUID maps to one portable-pty master, writer, child, requested cwd, dimensions, atomic lifecycle status, and event sink.

Creating a shell or agent opens a native portable PTY at the requested size, starts the child with `CommandBuilder::cwd`, stores the session, and starts exactly one named reader thread for that session. The frontend never supplies a shell command to this layer. Terminal IDs are UUID v4 strings.

## Session lifecycle and cleanup

- Create validates the cwd and dimensions, spawns the child, registers the UUID, emits the initial running status internally, and returns `TerminalSession`.
- Write looks up only the requested UUID, writes UTF-8 input to that session’s PTY writer, and flushes it.
- Resize validates `1..=10000` rows/columns, resizes only the requested PTY master, and updates that session’s recorded size.
- Kill removes only the requested UUID, atomically marks it killed, kills and waits for that child, then emits its exit event. A reader thread already in flight cannot remove a replacement session because removal uses UUID plus `Arc::ptr_eq`.
- Natural EOF/error marks the session exited/failed once, emits the matching lifecycle event, removes only that session, and waits for the child. There is no terminal-output polling loop.

## Output streaming

Each reader thread sends output chunks through an `EventSink`. Tauri uses `AppEventSink` in `src-tauri/src/commands.rs`:

```text
event: pty-output
payload: { "id": "<uuid>", "data": "<utf8-lossy chunk>" }

event: pty-exit
payload: { "id": "<uuid>", "exitCode": null }

event: pty-error
payload: { "id": "<uuid>", "message": "PTY reader stopped unexpectedly" }
```

Output uses UTF-8-lossy conversion because the current frontend bridge accepts string chunks. The PTY remains live and interactive; this is not simulated output.

## Available Tauri commands

The command registrations are in `src-tauri/src/lib.rs` and use Tauri managed state for `PtyManager` and `AgentManager`.

| Command | Request | Response |
| --- | --- | --- |
| `pty_create` | `{ cwd, cols, rows, title?, argv? }` | `TerminalSession` |
| `pty_write` | `{ id, data }` | `void` |
| `pty_resize` | `{ id, cols, rows }` | `void` |
| `pty_close` | `{ id }` | `void` |
| `list_agent_providers` | none | `AgentProvider[]` |
| `launch_agent` | `{ name, provider, cwd, cols?, rows? }` | `Agent` with `terminalId` |
| `stop_agent` | `{ id }` | `void` |
| `list_agents` | none | `Agent[]` |

The assignment-oriented aliases `create_terminal`, `write_terminal`, `resize_terminal`, `kill_terminal`, and `detect_agent_providers` are registered as well. `pty_create` rejects a non-empty `argv`; this prevents the frontend from turning terminal creation into unrestricted arbitrary shell execution. `title` is accepted for frontend compatibility but is not used by the OS process.

`TerminalSession` serializes as:

```json
{ "id": "<uuid>", "cwd": "C:\\path", "status": "running" }
```

`AgentProvider` serializes as `{ "id", "displayName", "executable", "installed" }`. Canonical provider IDs are `claude-code`, `codex`, and `cursor-agent`; the backend also accepts `claude` and `cursor` as launch aliases. `Agent` includes `id`, `name`, `provider`, `terminalId`, `cwd`, `branch`, `worktreePath`, `status`, and `error`.

## Shell detection

Windows priority is `pwsh`, `powershell.exe`, then `cmd.exe`. PATH lookup is performed directly with `PathBuf`; Windows PATHEXT plus `.PS1` are supported, and extensionless files are not launched as Win32 applications. macOS/Linux use `$SHELL` when valid and fall back to `/bin/sh` or `sh`.

Requested cwd values are validated as directories and canonicalized with `dunce`; spaces and Unicode are retained as filesystem paths and are never manually quoted into command strings.

## Coding CLI detection and launch

The provider catalog searches these reasonable candidates:

- Claude Code: `claude`, `.exe`, `.cmd`, `.ps1`
- Codex: `codex`, `.exe`, `.cmd`, `.ps1`
- Cursor Agent: `cursor-agent`, `.exe`, `.cmd`, `.ps1`, plus `agent` variants

The detected real executable is launched inside a PTY. `.ps1` shims run through detected PowerShell with `-NoLogo -NoProfile -ExecutionPolicy Bypass -File`; `.cmd`/`.bat` shims run through `cmd.exe /D /S /C`; native executables run directly. No AI API or fake output is used.

## Tests and checks performed

- `cargo test --manifest-path src-tauri/Cargo.toml pty::tests -- --nocapture`: 3 passed. Covers two simultaneous PTYs, independent output, independent resizing, killing A while B remains usable, real `git status`, and a cwd containing spaces and Unicode.
- `cargo test --manifest-path src-tauri/Cargo.toml an_installed_coding_cli_launches_inside_a_real_pty -- --nocapture`: 1 passed. The environment had real `claude.ps1`, `codex.ps1`, `cursor-agent.ps1`, and `agent.ps1` shims; the test launched the first detected coding CLI in a PTY and stopped it.
- `npm test`: 101 passed, 0 failed for the completed Wave 1 tree.
- `npm run lint`: passed.
- `npm run build`: passed.
- `cargo test --manifest-path src-tauri/Cargo.toml -j 1` with the shared target directory: 44 passed, 0 failed.
- `cargo check --manifest-path src-tauri/Cargo.toml -j 1` with the shared target directory: passed.

Run release checks before integration with:

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

## Normalized agent events and attention

The control plane emits `control-event` envelopes with camelCase fields and snake_case enum values. Current event kinds are:

```text
agent_created
agent_started
agent_output
agent_prompt_detected
agent_waiting
agent_message_received
agent_message_delivered
agent_completed
agent_failed
agent_paused
agent_stopped
agent_exited
agent_resume_available
agent_resume_unavailable
agent_worktree_created
agent_worktree_cleanup_failed
browser_surface_created
browser_navigation_changed
browser_console_error
browser_command_failed
taxchat_room_started
taxchat_message_sent
taxchat_message_failed
attention_ack
attention_mark_all_read
```

Execution, attention, and unread state are separate rules:

- Execution reports process state: `starting`, `running`, `paused`, `exited`, `error`, or `stopped`.
- Attention reports the user-facing state: `working`, `waiting_for_you`, `completed`, `failed`, `paused`, or `offline`.
- Unread reports whether an attention transition has been acknowledged. Acknowledgement clears `unread` and `unreadCount`; it does not change execution or attention.

`attention_ack` is scoped to one project and agent. `attention_mark_all_read` is scoped to one project and leaves other projects unread. Both commands publish their normalized event through the backend event hub before the frontend updates its projection.

The frontend subscribes before requesting `control_events_after(sequence)`. It replays from the cursor captured before subscription, orders accepted envelopes by `sequence` and `eventId`, and ignores an `eventId` already seen. A repeated ID never advances the backend sequence, even after its replay entry has been evicted.

Raw `agent_output` is activity only and never changes attention by itself. The PTY binding now carries the canonical provider ID and owns a bounded `AgentOutputNormalizer`. Every output chunk still emits `agent_output`; when the normalizer accepts a strong provider marker, the same boundary additionally emits `agent_prompt_detected` with source `provider`. The reducer then changes attention to `waiting_for_you`.

Prompt detection is deliberately narrow:

- Codex accepts an ANSI-rendered input line whose visible content is exactly `›`. The acceptance fixture includes the observed full-screen cursor-positioned frame and `? for shortcuts` footer.
- Claude Code accepts an ANSI-rendered input line whose visible content is exactly `❯`. The acceptance fixture includes the observed line-clear, carriage-return, bold prompt form.
- ANSI CSI/OSC sequences and prompt bytes split across PTY chunks are handled incrementally. A PTY chunk boundary is not treated as a line boundary; detection waits for newline, cursor relocation, or the provider frame's visible-cursor sequence. Visible line state is capped at 1024 bytes, CSI parameter state at 16 bytes, and output received before agent binding at 8192 bytes.
- A prompt is latched after emission. Redraws do not emit another prompt event. A PTY input request containing carriage return or newline starts a clean prompt epoch by discarding the prior visible line and partial ANSI candidate before rearming. The agent mapping lock is released before the writer can block, so PTY output normalization remains live during writes. Terminal exit, failure, or stop clears and disables detector state.
- `shell`, `cursor-agent`, and unknown providers do not infer prompts. Add a provider only when a stable, provider-specific marker is backed by real fixtures.

Generic low-confidence candidates still require at least five seconds without output and active working state, but they do not change attention unless a detector publishes a normalized accepted event. Prompt-like ordinary output remains working.

The backend replay deque is capacity-bounded, but the hub retains historical event IDs so an evicted duplicate cannot be accepted again. This set can grow for a long-running runtime. Address that memory concern in the runtime batching phase with output batching and lifecycle-aware ID retention.

Run the Wave 1 verification set from the repository root:

```powershell
npm test
npm run lint
npm run build
$env:CARGO_TARGET_DIR='D:\Taxzy_CLI\src-tauri\target'; cargo test --manifest-path src-tauri/Cargo.toml -j 1
$env:CARGO_TARGET_DIR='D:\Taxzy_CLI\src-tauri\target'; cargo check --manifest-path src-tauri/Cargo.toml -j 1
rustfmt --edition 2021 --check src-tauri/src/control/tests.rs
git diff --check
```

If a Rust test or check fails only with the known Windows `Access is denied. (os error 5)` process-launch error, retry that identical command once. Do not retry other failures without diagnosing them.

## Frontend integration

The existing `src/tauri/terminal.ts` wrapper already uses `pty_create`, `pty_write`, `pty_resize`, and `pty_close`; `src/terminal/ptyBridge.ts` already listens for `pty-output`, `pty-exit`, and `pty-error`. Ensure `startPtyBridge()` runs once before terminal interaction and pass absolute `cwd`, `cols`, and `rows` to `ptyCreate`.

For agents, call `list_agent_providers()` and use the canonical catalog IDs. `launch_agent` returns an `Agent` whose `terminalId` is the interactive PTY session. Use `stop_agent(agent.id)` to terminate it. The backend deliberately does not create worktrees: when a worktree is desired, the Git subsystem must first return the worktree path, then the frontend should launch the agent with that path.

## Known limitations

- Exit codes are currently emitted as `null`; portable-pty child waiting is used for cleanup but the reader event contract does not yet carry the exact exit code.
- Agent records use an empty `branch` and `null` `worktreePath` because worktree/branch ownership belongs to the Git engineer and is not fabricated here.
- Agent launch accepts no user-provided CLI arguments. This keeps the command constrained; provider-specific flags can be added later as an explicit allowlisted contract.
- The backend does not persist sessions or agent records across application restarts.
