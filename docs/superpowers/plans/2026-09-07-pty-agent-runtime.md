# PTY and Agent Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the real portable-pty-backed Tauri runtime for independent terminal sessions and installed coding-agent CLIs.

**Architecture:** Keep PTY state behind a mutex-protected UUID registry. Spawn one OS child and one reader thread per session, route output through Tauri events, and expose only structured commands for terminal lifecycle and provider launch.

**Tech Stack:** Tauri 2, Rust, portable-pty, serde, uuid, Git CLI, Windows PowerShell/cmd with Unix shell fallback.

**Spec:** `docs/superpowers/specs/2026-09-07-pty-agent-runtime-design.md`

## Global Constraints

- Rust owns PTYs, child processes, shell detection, CLI detection, and filesystem-sensitive operations.
- Never expose unrestricted arbitrary shell execution from the frontend.
- Multiple terminals must work independently, and closing one must not affect another.
- Paths containing spaces and Unicode must remain valid.
- Never implement Git worktree/diff/merge functionality in this subsystem.

---

### Task 1: Bootstrap the Rust/Tauri backend and dependency contracts

**Files:**
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/lib.rs`
- Create: `src-tauri/src/main.rs`
- Create: `src-tauri/src/pty/mod.rs`
- Create: `src-tauri/src/system/mod.rs`
- Create: `src-tauri/src/agents/mod.rs`

- [ ] **Step 1: Write the failing contract test**

Add tests that reference the terminal and provider data structures before their implementations exist.

- [ ] **Step 2: Run the focused test and confirm the expected missing-module failure**

Run `cargo test --manifest-path src-tauri/Cargo.toml` and confirm compilation fails because the backend modules are not yet defined.

- [ ] **Step 3: Add the minimal Cargo manifest and serializable contracts**

Define the Tauri, portable-pty, serde, serde_json, and uuid dependencies. Add `TerminalSession`, `TerminalStatus`, and `AgentProvider` contracts with string IDs and filesystem paths serialized as strings.

- [ ] **Step 4: Run the focused tests and confirm the contract surface compiles**

Run `cargo test --manifest-path src-tauri/Cargo.toml` and confirm the contract tests pass.

### Task 2: Implement shell and agent executable detection

**Files:**
- Modify: `src-tauri/src/system/mod.rs`
- Modify: `src-tauri/src/agents/mod.rs`
- Test: `src-tauri/src/system/mod.rs` and `src-tauri/src/agents/mod.rs` unit tests

- [ ] **Step 1: Write failing tests for candidate ordering and provider mapping**

Assert Windows shell priority is `pwsh`, `powershell.exe`, then `cmd.exe`, Unix fallback prefers `$SHELL`, and Cursor includes multiple known executable candidates.

- [ ] **Step 2: Run tests to confirm they fail for missing detection functions**

Run `cargo test --manifest-path src-tauri/Cargo.toml system::tests agents::tests`.

- [ ] **Step 3: Implement lookup helpers without shell-string execution**

Use `where.exe`/`command -v` as constrained executable lookup helpers and keep `PathBuf`/`OsString` values unquoted until `Command`/PTY spawn.

- [ ] **Step 4: Run the tests and confirm detection behavior**

Run the same focused cargo test command and confirm all provider/candidate tests pass.

### Task 3: Implement the PTY session manager

**Files:**
- Create: `src-tauri/src/pty/manager.rs`
- Modify: `src-tauri/src/pty/mod.rs`
- Test: `src-tauri/src/pty/manager.rs` integration-style tests

- [ ] **Step 1: Write failing tests for two independent real PTYs**

Create sessions with the detected shell, write distinct markers, resize one, kill one, and assert the second remains writable/alive. Add a `git status` command through a shell session and assert it exits successfully.

- [ ] **Step 2: Run tests to confirm the PTY manager is missing**

Run `cargo test --manifest-path src-tauri/Cargo.toml pty::manager`.

- [ ] **Step 3: Implement UUID-keyed lifecycle and reader-thread event routing**

Open one portable PTY per session, spawn its child in the requested cwd, store the master/child/shutdown state in an `Arc<Mutex<HashMap<Uuid, ...>>>`, and have one reader thread emit `terminal-output` and `terminal-status` events. Validate cwd and dimensions, and remove only the matching session on EOF or kill.

- [ ] **Step 4: Run PTY tests and inspect independent-session behavior**

Run `cargo test --manifest-path src-tauri/Cargo.toml pty::manager -- --nocapture` and verify both sessions are alive simultaneously, only A receives A's marker, resizing A succeeds without changing B, killing A leaves B usable, and the real shell can run `git status`.

### Task 4: Add constrained Tauri commands and agent launch

**Files:**
- Create: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/agents/mod.rs`
- Test: `src-tauri/src/commands.rs` unit tests

- [ ] **Step 1: Write failing command contract tests**

Assert command handlers reject unknown provider IDs, invalid dimensions, and missing session IDs, while valid provider launches create a PTY session.

- [ ] **Step 2: Run tests to confirm handlers are missing**

Run `cargo test --manifest-path src-tauri/Cargo.toml commands`.

- [ ] **Step 3: Implement structured commands and registration**

Register `create_terminal`, `write_terminal`, `resize_terminal`, `kill_terminal`, `list_agent_providers`, and `launch_agent`. Agent launch takes a provider ID and cwd, resolves only a detected executable candidate, and spawns the real CLI in a PTY with no arbitrary frontend command or argument string.

- [ ] **Step 4: Run the full Rust test suite**

Run `cargo test --manifest-path src-tauri/Cargo.toml` and confirm all unit/integration tests pass.

### Task 5: Document, verify, and commit the subsystem

**Files:**
- Create: `docs/HANDOFF_CODEX.md`

- [ ] **Step 1: Write the handoff with exact commands and payloads**

Document architecture, lifecycle, output/status event payloads, command arguments/results, shell and CLI detection, tests performed, known limitations, and frontend integration instructions.

- [ ] **Step 2: Run release checks**

Run `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`, `cargo check --manifest-path src-tauri/Cargo.toml`, and `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`.

- [ ] **Step 3: Review the final diff for ownership boundaries**

Run `git status --short` and `git diff --stat`; confirm only the backend, command registration, design/plan records, and handoff changed.

- [ ] **Step 4: Commit the verified implementation**

Run `git add src-tauri docs` followed by `git commit -m "feat(core): implement PTY and agent runtime"`.
