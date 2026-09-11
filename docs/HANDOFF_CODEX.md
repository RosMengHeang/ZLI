# Engineer A Handoff: PTY and Agent Runtime

## Scope

This handoff covers the Rust backend for v0.1 real terminals and the backend portion of v0.2 coding-agent launch. Git worktree, status, diff, commit, merge, and discard logic remains in `src-tauri/src/git/` and was not changed here.

## PTY architecture

`src-tauri/src/pty/manager.rs` contains `PtyManager`, a clonable handle around an `Arc<ManagerInner>`. `ManagerInner` owns a `Mutex<HashMap<Uuid, Arc<SessionHandle>>>`; each UUID maps to one portable-pty master, writer, child, requested cwd, dimensions, atomic lifecycle status, and event sink.

Creating a shell or agent opens a native portable PTY at the requested size, starts the child with `CommandBuilder::cwd`, stores the session, and starts one named reader thread plus one child-waiter thread for that session. The reader owns terminal output while the waiter owns process lifecycle, so a child can be marked exited even if ConPTY output remains open. The frontend never supplies a shell command to this layer. Terminal IDs are UUID v4 strings.

## Session lifecycle and cleanup

- Create validates the cwd and dimensions, spawns the child, registers the UUID, emits the initial running status internally, and returns `TerminalSession`.
- Write looks up only the requested UUID, writes UTF-8 input to that session’s PTY writer, and flushes it.
- Resize validates `1..=10000` rows/columns, resizes only the requested PTY master, and updates that session’s recorded size.
- Kill removes only the requested UUID, atomically marks it killed, kills and waits for that child, then emits its exit event. A reader thread already in flight cannot remove a replacement session because removal uses UUID plus `Arc::ptr_eq`.
- The reader streams output and reports reader failures; a separate child waiter polls process completion and marks natural exits with the numeric code when available. Each lifecycle transition is emitted once, removes only that session, and cannot overwrite a prior killed or failed state. There is no terminal-output polling loop.

## Crash-safe process ownership

When a PTY child is created on Windows, ZLI records a process identity containing
the PID, native process creation timestamp, and full executable path. The
versioned ledger lives at `<app-data>/control/runtime-ownership.json`; it never
stores command arguments, environment variables, tokens, cookies, or message
bodies. Reconciliation checks all three identity fields through a native process
handle. Only an exact match may be terminated, and the handle used for the
identity check is also the handle used for termination, preventing PID reuse
from targeting another process. Mismatches and inaccessible processes remain
retained as unknown records for review. A normal application exit clears only
records associated with the current session registry; a crash leaves records
for the next startup to reconcile.

`ReconcileReport` exposes `orphanedOwnedProcessIds`,
`stoppedOwnedProcessIds`, `unknownProcessIds`, and
`clearedOwnershipRecordIds` alongside offline sessions and retained worktrees.

## Output streaming

Each reader thread sends output chunks through an `EventSink`. Tauri uses `AppEventSink` in `src-tauri/src/commands.rs`:

```text
event: pty-output
payload: { "id": "<uuid>", "data": "<utf8-lossy chunk>" }

event: pty-exit
payload: { "id": "<uuid>", "exitCode": 0 }

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
agent_message_queued
agent_message_delivered
agent_message_failed
agent_focus_requested
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
taxchat_message_queued
taxchat_message_delivered
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

For agents, call `list_agent_providers()` and use the canonical catalog IDs. `launch_agent` returns an `Agent` whose `terminalId` is the interactive PTY session. Use `stop_agent(agent.id)` to terminate it. Ordinary UI launches still create worktrees through the Git subsystem first. Autonomous team spawning owns that transaction in the backend so a failed launch can revoke its token, stop a partial process, and remove only the newly created clean worktree.

## ZLI local API and autonomous teams

Protocol version `1` is shared by the Tauri UI and the `zli` executable. On Windows the app listens on a randomly named, current-user-only named pipe; remote clients are rejected and the connecting process must have the same user SID. Frames are limited to 1 MiB. The app writes its CLI endpoint, protocol version, expiring token and process ID to `%APPDATA%\com.taxzy.cli\control\endpoint.json`. This file is runtime discovery data, not a persistent credential.

Use `npm run tauri dev` during development. That wrapper builds the sibling debug `zli.exe` before starting Tauri. Use `npm run tauri build` for a release: the wrapper builds the CLI for the active Rust target, copies it to the target-triple filename required by Tauri, and enables `bundle.externalBin` only for that release invocation. Keeping the sidecar out of the base config lets clean Rust tests and checks run without generated binaries.

The CLI command surface is:

```text
zli status
zli agents
zli attention
zli attention ack <agent-id> --project <project-path>
zli agent queue [--project <project-path>]
zli agent spawn --project <project-path> --provider <provider> --task <task> [--name <name>]
zli agent send <agent-id> <message>
zli agent read <agent-id>
zli agent focus <agent-id>
zli agent pause <agent-id>
zli agent stop <agent-id>
zli session list
zli session reconcile
zli session resume <session-id>
zli doctor
zli browser list
zli browser open <url> --project <project-path>
zli browser navigate <surface-id> <url>
zli browser snapshot <surface-id> [--selector <css>] [--depth <1-32>]
zli browser click <surface-id> <css-selector>
zli browser fill <surface-id> <css-selector> <text>
zli browser press <surface-id> <key>
zli browser wait <surface-id> --selector <css> [--state visible|hidden|attached|detached] [--timeout <ms>]
zli browser console <surface-id>
zli browser errors <surface-id>
zli browser screenshot <surface-id>
zli browser eval <surface-id> <script>
zli taxchat send <message> --project <project-path> [--to <agent-id>]...
```

All listed routes are active. A managed child may omit the TaxChat project because `ZLI_PROJECT_ID` supplies it. Without `--to`, TaxChat targets the active sessions in that project; repeated `--to` flags select up to 12 recipients. The backend queues each recipient independently behind the provider prompt, returns `queuedIds` and `failedIds`, and emits a later delivered or failed event for each queued recipient. Its bounded event is projected into the visible TaxChat transcript and the next project checkpoint.

`zli agent queue` exposes safe queue diagnostics for the current project, or all projects for the local CLI. It returns only project and agent IDs, pending and in-flight counts, and the oldest message ID. Message bodies and terminal contents are never included.

Pass `--json` before or after a command for the strict response envelope. Managed child agents can omit `--project`; their injected `ZLI_PROJECT_ID` supplies it. The older positional spawn form remains accepted for compatibility.

Every managed child receives only these scoped environment values:

```text
ZLI_PROJECT_ID
ZLI_AGENT_ID
ZLI_PARENT_AGENT_ID
ZLI_CONTROL_ENDPOINT
ZLI_CONTROL_TOKEN
ZLI_COMMAND
```

`ZLI_COMMAND` is the absolute bundled CLI path. Its containing directory is also prepended to the child process `PATH`, so managed agents may invoke either the explicit path or `zli` without a machine-wide install.

The token is random, stored hashed in memory, expires after 12 hours, and is revoked when the child is stopped. Router authorization checks both the method capability and any explicit `projectId`. Child tokens can list, spawn, send, and read attention/session state. Browser commands additionally require an explicit grant on the current project profile; possessing a token alone is not enough. Children cannot discard worktrees, execute arbitrary commands, access browser storage, download files, or evaluate JavaScript. `browser.eval` has a separate capability and a separate user grant.

`agent.spawn` validates the parent relationship, provider installation, task size and the project-wide limit of 12 active agents. Every child gets an isolated worktree and terminal pane. Parent IDs are persisted in session descriptors, so sidebar nesting survives a restart. `agent.send` performs one PTY write and never retries after failure. Pause blocks automated messages without stopping the process; stop terminates the process but retains the worktree for review. Failed cleanup is intentionally retained for **Manage worktrees** instead of deleting potentially useful files.

To add a command, add one `ControlMethod`, map it to a dedicated `Capability`, implement it behind `ControlHandler`, add both Rust and TypeScript wire tests, and expose it in the CLI parser. Do not bypass the router from a new UI surface.

## Agent-controlled browser

The browser pane is the real Tauri WebView2 surface shown beside the terminals. Open a page normally, select the shield in its toolbar, and grant only what the agent needs. `Read pages` permits DOM snapshots, console messages, page errors, and waits. `Control pages` permits navigation, click, fill, key presses, and native PNG screenshots. `Run JavaScript` is separate because it can read or modify anything the loaded page exposes. All grants default to off and are scoped to the current project and browser profile; they can be revoked from the same dialog.

The backend owns authorization, surface identity, project/agent isolation, deadlines, and result limits. The UI only registers the visible WebView2 label and displays grants/status. Selectors, text, and scripts are serialized before entering fixed browser expressions. Snapshots are limited to 100,000 characters, scripts to 20,000 characters, selectors to 4,096 characters, console output to 500 entries, page errors to 200 entries, screenshots to 10,000,000 encoded characters, and command deadlines to 120 seconds. Arbitrary JavaScript, storage access, and downloads are never implied by read/control permission.

Safe browser checkpoint fields are URL, open state, profile ID, and granted capability names. Cookies, local/session storage, authorization values, download data, and WebView2 profile contents are not written into ZLI project snapshots. Surface IDs are runtime-only and change when a pane is recreated.

For a local test page, start its development server, open it in the ZLI browser, grant `Read pages`, then run `zli browser list --json` to obtain the surface ID. `zli browser snapshot <surface-id> --selector main` inspects it, while `zli browser errors <surface-id>` and `zli browser console <surface-id>` expose bounded diagnostics. A managed child can omit `--project` from `browser open`; external shells must supply it.

## Durable session startup and recovery

`Supervisor` starts as managed Tauri state before the main window is created. The frontend restores an opened project in this order: load its versioned snapshot, rebuild backend runtime records idempotently, reconnect with protocol version `1` and the saved event cursor, project the records into the agent and terminal stores, then restore the validated pane tree. Pane selection and focus are intentionally transient.

Project snapshots are written atomically every five seconds while a project is open and once more when that project view closes. They live below Tauri's platform-specific application data directory at `control/projects/<encoded-project-id>/project.json`. The encoded folder name is storage-only; the JSON retains the original absolute repository path as `projectId`. A snapshot contains bounded terminal scrollback, agent descriptors, pane layout, browser state, TaxChat state, the latest control-event sequence, schema version, and save time.

The restore UI never claims that a new conversation is the old one:

- A runtime session still owned by the current supervisor is shown as `Reconnect` and reattaches its event sink.
- A stopped Claude Code or Codex session is shown as `Resume` only when the provider adapter found an exact provider session ID.
- A provider with no resume protocol is shown as unavailable.
- Missing or ambiguous resume evidence is shown as `Start new`.

Closing the entire desktop process cannot preserve an in-memory PTY. On the next launch, ZLI reconstructs its record and uses the provider's supported resume command when an exact ID was checkpointed. The Tauri exit hook now shuts down every PTY owned by the current runtime before the process exits, while unknown external processes are never killed during reconciliation. Missing worktrees make the session offline; orphaned or dirty worktrees are retained for the user to inspect from **Manage worktrees** and remove through the normal discard flow. If Windows reports `Permission denied`, close external terminals or tools holding files in that worktree and retry cleanup.

Session commands are `control_session_reconnect`, `control_session_reconcile`, `control_session_snapshot`, `control_session_restore`, and `control_session_resume`. `zli session reconcile` and its `zli doctor` alias return a safe report of sessions that became offline, retained worktree paths that no longer exist, and owned processes stopped during reconciliation. ZLI never deletes a worktree from reconciliation. Errors are tagged with stable codes for missing sessions, unsupported resume, protocol mismatch, snapshot failure, and runtime failure.

Agent and TaxChat delivery queues are also durable. ZLI stores the bounded pending queue in the application data directory as a versioned, atomically replaced file. A message is kept until the provider delivery attempt is acknowledged, so a crash can replay an in-flight message instead of silently losing it. This is intentionally at-least-once delivery: if the process stops after the provider accepts the prompt but before the acknowledgement is saved, the provider may receive a duplicate after restart. Message IDs remain stable so consumers and the UI can deduplicate safely.

Worktree storage can be inspected without mutation through `git_audit_worktrees({ repositoryRoot })`. The audit distinguishes protected main and runtime-owned checkouts, dirty or unreadable registered worktrees, locked entries, stale Git metadata, and empty or non-empty orphaned agent folders. Only an empty orphaned folder is marked safe for non-forced filesystem removal; stale Git metadata is separately marked safe for `git worktree prune`. The audit never deletes files or assumes that a clean checkout is unused.

The same read-only report is available through the authenticated CLI as `zli worktree audit --project <project-path>`; the command has no force or delete mode.

## Known limitations

- Numeric child exit codes are propagated through `pty-exit` and the normalized agent exit event. A missing code remains `null` when the provider or operating system cannot expose one.
- Agent launch accepts no user-provided CLI arguments. This keeps the command constrained; provider-specific flags can be added later as an explicit allowlisted contract.
- Only Claude Code and Codex currently have provider-specific resume commands. Cursor Agent, OpenCode, Gemini, Aider, and Goose remain visible after restore but require a new session unless their adapters gain a verified resume protocol.
- Full application shutdown ends PTY processes. Persistence restores layout, bounded scrollback, metadata, and supported provider conversations; it does not keep an OS process alive outside the desktop runtime.
- Durable coordination protects queued delivery, not provider-side work already in progress. A restarted provider session still depends on its adapter's exact resume support.
