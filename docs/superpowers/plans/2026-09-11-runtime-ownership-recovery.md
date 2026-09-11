# Runtime Ownership Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist enough process identity to recover ZLI-owned provider processes after a crash without ever terminating a reused PID or an unknown external process.

**Architecture:** The PTY layer captures a Windows process identity at spawn time: PID, native creation timestamp, and executable path. A control-plane ownership ledger stores those identities atomically outside project repositories. Reconciliation compares all three fields through one native process handle, terminates only an exact match, and reports mismatches as retained unknown records. Normal application shutdown removes only records belonging to the current runtime.

**Tech Stack:** Rust 2021, Tauri 2, `portable-pty`, `windows-sys`, `serde_json`, atomic file replacement, existing control-plane event and reconciliation APIs.

**Spec:** `docs/superpowers/specs/2026-09-10-agent-control-plane-design.md`

## Global Constraints

- Unknown or mismatched processes are never killed automatically.
- PID matching alone is insufficient; recovery requires PID, process creation timestamp, and executable path to match.
- Ownership data is stored under the application control directory, never inside a project or worktree.
- Ownership records contain no environment variables, command bodies, tokens, cookies, or provider secrets.
- Persistence uses versioned JSON and atomic replacement; a newer schema is retained and reported as an error.
- Normal shutdown is idempotent and clears only ownership records associated with the current runtime.
- Existing PTY, control-plane, provider, and worktree behavior must remain compatible.

---

### Task 1: Capture native process identity from owned PTYs

**Files:**
- Create: `src-tauri/src/pty/process.rs`
- Modify: `src-tauri/src/pty/mod.rs`
- Modify: `src-tauri/src/pty/manager.rs`
- Test: `src-tauri/src/pty/mod.rs`

**Interfaces:**
- Produces `ProcessIdentity { pid, start_time, executable }`, `capture(pid)`, `inspect(identity)`, and `terminate_verified(identity)`.
- Produces `PtyManager::process_identity(terminal_id)` returning `Option<ProcessIdentity>`.
- `ProcessIdentity` is serializable with camelCase fields and contains no command arguments or environment data.

- [ ] **Step 1: Write the failing process identity test**

Add a Windows-only test that launches `cmd.exe /C exit 0`, obtains the terminal process identity before exit, and asserts a non-zero PID, non-zero creation timestamp, and an executable path ending in `cmd.exe`.

- [ ] **Step 2: Run the test to verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib pty::tests::owned_terminal_exposes_process_identity -j 1 -- --nocapture`

Expected: FAIL because `PtyManager::process_identity` and `ProcessIdentity` do not exist.

- [ ] **Step 3: Implement native identity capture and exact matching**

On Windows, query the process through `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)`, read `GetProcessTimes` creation time and `QueryFullProcessImageNameW` executable path, and classify a record as matching only when PID, creation timestamp, and case-insensitive normalized executable path all match. `terminate_verified` must query and terminate using the same handle to avoid a PID-reuse race. On non-Windows, return `None` from capture and `Unknown` from inspection so the feature fails closed.

- [ ] **Step 4: Store the identity on `SessionHandle`**

Capture the identity immediately after `portable_pty` spawns the child, expose it through `PtyManager::process_identity`, and leave `None` when the platform cannot provide a safe identity. Do not change terminal output or process lifecycle events.

- [ ] **Step 5: Run the focused test**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib pty::tests::owned_terminal_exposes_process_identity -j 1 -- --nocapture`

Expected: PASS.

- [ ] **Step 6: Commit**

```text
git add src-tauri/src/pty/process.rs src-tauri/src/pty/mod.rs src-tauri/src/pty/manager.rs
git commit -m "feat: capture owned process identities"
```

### Task 2: Add the versioned ownership ledger

**Files:**
- Create: `src-tauri/src/control/ownership.rs`
- Modify: `src-tauri/src/control/mod.rs`
- Modify: `src-tauri/src/control/persistence.rs`
- Test: `src-tauri/src/control/tests.rs`

**Interfaces:**
- Produces `RuntimeOwnershipRecord`, `OwnershipLedger::load`, `OwnershipLedger::record`, `OwnershipLedger::remove`, `OwnershipLedger::remove_for_terminals`, and `OwnershipLedger::records`.
- The ledger file is `<app-data>/control/runtime-ownership.json` with `schemaVersion: 1` and an array of records.

- [ ] **Step 1: Write failing ledger tests**

Add tests for atomic round-trip, future-schema rejection, replacement of one session record without duplicating it, and removal by terminal ID. Assert that the serialized file does not contain `environment`, `token`, `cookie`, or `command` fields.

- [ ] **Step 2: Run the tests to verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib control::tests::ownership_ledger -j 1 -- --nocapture`

Expected: FAIL because `OwnershipLedger` is not defined.

- [ ] **Step 3: Implement the ledger**

Use a dedicated versioned document and the existing atomic control-file replacement helper. Validate non-empty session, agent, project, terminal, and executable values; reject invalid or future schema versions; treat a missing file as an empty ledger; and preserve no secret-bearing fields.

- [ ] **Step 4: Run the ledger tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib control::tests::ownership_ledger -j 1 -- --nocapture`

Expected: PASS.

- [ ] **Step 5: Commit**

```text
git add src-tauri/src/control/ownership.rs src-tauri/src/control/mod.rs src-tauri/src/control/persistence.rs src-tauri/src/control/tests.rs
git commit -m "feat: persist runtime ownership records"
```

### Task 3: Reconcile and safely recover orphaned processes

**Files:**
- Modify: `src-tauri/src/control/reconcile.rs`
- Modify: `src-tauri/src/control/supervisor.rs`
- Modify: `src-tauri/src/control/tests.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Extends `ReconcileReport` with `orphaned_owned_process_ids`, `unknown_process_ids`, and `cleared_ownership_record_ids`.
- Adds `Supervisor::shutdown` to clear only current-runtime ledger records after PTY shutdown.

- [ ] **Step 1: Write failing recovery tests**

Add one test with an exact live identity that expects `reconcile` to terminate it and report its PID, one test with the same PID but a different creation timestamp that expects retention and no termination, and one test that invokes `Supervisor::shutdown` and verifies unrelated unknown records remain.

- [ ] **Step 2: Run the tests to verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib control::tests::reconcile_ownership -j 1 -- --nocapture`

Expected: FAIL because reconciliation does not read ownership records or expose the new report fields.

- [ ] **Step 3: Register and remove records at runtime boundaries**

When an agent is registered, obtain its PTY identity and atomically record it. If no safe identity is available, continue without a killable ownership record. On reconciliation, inspect ledger records not backed by a running ZLI PTY: terminate only exact matches, clear records for exited processes, and retain mismatches or inspection failures with an explicit unknown status.

- [ ] **Step 4: Wire normal application shutdown**

After the existing `PtyManager::shutdown()` call in the Tauri exit handler, call `Supervisor::shutdown()` so current runtime records are removed. Keep both operations idempotent and never clear records that are not associated with the current session registry.

- [ ] **Step 5: Run focused recovery tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib control::tests::reconcile_ownership -j 1 -- --nocapture`

Expected: PASS.

- [ ] **Step 6: Commit**

```text
git add src-tauri/src/control/reconcile.rs src-tauri/src/control/supervisor.rs src-tauri/src/control/tests.rs src-tauri/src/lib.rs
git commit -m "feat: recover verified orphaned processes"
```

### Task 4: Verify the complete reliability contract

**Files:**
- Modify: `docs/HANDOFF_CODEX.md`
- Test: `src-tauri/src/pty/mod.rs`
- Test: `src-tauri/src/control/tests.rs`

- [ ] **Step 1: Document the ownership lifecycle**

Document the ledger path, exact-match rule, retained unknown behavior, and normal-shutdown cleanup. State clearly that abrupt termination can leave an ownership record for the next startup to reconcile, but no unknown process is automatically killed.

- [ ] **Step 2: Run all checks**

Run:

```text
cargo test --manifest-path src-tauri/Cargo.toml --all-targets -j 1
npm test -- --test-reporter=dot
npm run lint
npm run build
git diff --check
```

Expected: all tests and checks pass. Existing non-fatal Vite ineffective-dynamic-import warnings may remain documented.

- [ ] **Step 3: Commit documentation and merge**

```text
git add docs/HANDOFF_CODEX.md
git commit -m "docs: describe runtime ownership recovery"
```

Fast-forward the feature branch into local `main`, verify `main` is clean, and remove only the feature worktree after its status is clean.
