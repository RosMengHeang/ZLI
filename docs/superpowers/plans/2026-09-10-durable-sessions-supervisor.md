# ZLI Durable Sessions and Runtime Supervisor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve ZLI workspace state and reconnectable agent sessions across UI restarts, while keeping provider-specific resume behavior behind adapters.

**Architecture:** Move ownership of live PTYs and process handles behind a runtime interface. Persist versioned checkpoints in the application data directory, not project repositories. Use a detached Rust supervisor for sessions configured to survive UI closure, with a reconnect protocol and idempotent reconciliation.

**Tech Stack:** Rust 2021, Tauri 2, `portable-pty`, `serde_json`, `uuid`, atomic file writes, React 19, Zustand 5, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-10-agent-control-plane-design.md`

## Global Constraints

- The backend owns live agent state; the frontend owns transient selection and view state.
- Restored provider conversations must report unsupported resume honestly.
- Snapshots never contain secrets, API keys, passwords, cookies, or unrestricted environment variables.
- Terminal scrollback and event journals are bounded.
- Restore must be idempotent and must not create duplicate agents or worktrees.
- Existing `portable-pty` terminal behavior and Windows support must continue to work.

## File map

- Create `src-tauri/src/control/persistence.rs`: versioned snapshots and atomic persistence.
- Create `src-tauri/src/control/session.rs`: durable session records and restore planning.
- Create `src-tauri/src/control/runtime.rs`: runtime traits and session ownership abstraction.
- Create `src-tauri/src/control/supervisor.rs`: supervisor lifecycle and reconnect state.
- Create `src-tauri/src/control/reconcile.rs`: stale runtime, agent, browser, and worktree reconciliation.
- Create `src-tauri/src/agents/providers/mod.rs`: provider adapter registry and shared launch types.
- Create `src-tauri/src/agents/providers/claude_code.rs`, `codex.rs`, `cursor.rs`, and `opencode.rs`.
- Modify `src-tauri/src/pty/manager.rs`: expose attach/detach-safe PTY session operations.
- Modify `src-tauri/src/commands.rs`: add session snapshot, reconnect, and resume commands.
- Modify `src-tauri/src/lib.rs`: initialize supervisor and persistence services.
- Create `src/lib/sessionPersistence.ts`: frontend checkpoint/read-model types.
- Create `src/stores/sessionStore.ts`: restore/reconnect UI state.
- Modify `src/stores/workspaceStore.ts`: migrate saved agent recipes into backend-owned session records.
- Modify `src/stores/layoutStore.ts`: serialize and restore pane trees through session commands.
- Modify `src/components/Workspace.tsx`: render reconnect, restore and unsupported-resume states.
- Create `tests/sessionPersistence.test.mjs`, `tests/sessionRestore.test.mjs`, and Rust control tests.

## Interfaces

```rust
pub trait RuntimeSession: Send + Sync {
    fn id(&self) -> &str;
    fn agent_id(&self) -> &str;
    fn attach(&self, sink: Arc<dyn TerminalSink>) -> Result<()>;
    fn detach(&self) -> Result<()>;
    fn write(&self, data: &str) -> Result<()>;
    fn resize(&self, cols: u16, rows: u16) -> Result<()>;
    fn stop(&self) -> Result<ExitInfo>;
}

pub trait RuntimeSupervisor: Send + Sync {
    fn start(&self, plan: LaunchPlan) -> Result<SessionDescriptor>;
    fn reconnect(&self, session_id: &str, sink: Arc<dyn TerminalSink>) -> Result<SessionDescriptor>;
    fn snapshot(&self, session_id: &str) -> Result<SessionCheckpoint>;
    fn stop(&self, session_id: &str) -> Result<ExitInfo>;
}
```

```ts
export interface SessionCheckpoint {
  schemaVersion: 1;
  projectId: string;
  agents: SessionAgentCheckpoint[];
  paneTree: unknown;
  browser: BrowserCheckpoint[];
  taxChatRoom: unknown | null;
  lastEventSequence: number;
  savedAt: string;
}
```

### Task 1: Add versioned persistence primitives

**Files:**
- Create: `src-tauri/src/control/persistence.rs`
- Create: `src/lib/sessionPersistence.ts`
- Test: `src-tauri/src/control/tests.rs`
- Test: `tests/sessionPersistence.test.mjs`

**Interfaces:**
- Produces `SnapshotStore::load`, `SnapshotStore::save_atomic`, `SnapshotStore::delete_project`, and schema version `1`.
- Consumes application-data directory resolution from Tauri.

- [ ] **Step 1: Write the failing atomic-save test**

```rust
#[test]
fn snapshot_store_round_trips_and_writes_schema_version() {
    let root = tempfile::tempdir().expect("temp dir");
    let store = SnapshotStore::new(root.path().to_path_buf());
    let snapshot = ProjectSnapshot::empty("project-1".into());
    store.save_atomic(&snapshot).expect("save snapshot");
    let loaded = store.load("project-1").expect("load snapshot").expect("snapshot exists");
    assert_eq!(loaded.schema_version, 1);
    assert_eq!(loaded.project_id, "project-1");
    assert!(!root.path().join("control/projects/project-1/project.json.tmp").exists());
}
```

- [ ] **Step 2: Run the test to verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml control::tests::snapshot_store_round_trips_and_writes_schema_version`

Expected: FAIL because `SnapshotStore` is not defined.

- [ ] **Step 3: Implement the store**

Resolve the control directory under the Tauri application data directory. Serialize with `serde_json::to_vec_pretty`, write to a sibling `.tmp` file, flush, and rename over the destination. Load missing files as `None`, reject unsupported future schema versions with a stable error, and preserve valid unknown fields using a `serde_json::Value` extension map.

- [ ] **Step 4: Add TypeScript snapshot validation**

Implement `isSessionCheckpoint(value: unknown)` and reject snapshots whose `schemaVersion` is not `1`, whose IDs are empty, or whose `savedAt` is not an ISO timestamp. The decoder must return a typed error instead of throwing an unbounded raw payload into a store.

- [ ] **Step 5: Run tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml control::tests::snapshot_store_round_trips_and_writes_schema_version`

Run: `npm test -- --test-name-pattern="session persistence"`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/control/persistence.rs src-tauri/src/control/tests.rs src/lib/sessionPersistence.ts tests/sessionPersistence.test.mjs
git commit -m "feat: add versioned session snapshots"
```

### Task 2: Add provider adapter interfaces and resume descriptors

**Files:**
- Create: `src-tauri/src/agents/providers/mod.rs`
- Create: `src-tauri/src/agents/providers/claude_code.rs`
- Create: `src-tauri/src/agents/providers/codex.rs`
- Create: `src-tauri/src/agents/providers/cursor.rs`
- Create: `src-tauri/src/agents/providers/opencode.rs`
- Modify: `src-tauri/src/agents/mod.rs`
- Test: `src-tauri/src/agents/providers/tests.rs`

**Interfaces:**
- Produces `ProviderAdapter`, `ProviderRegistry`, `LaunchPlan`, `ResumeDescriptor`, and `ProviderEvent`.
- Consumes existing provider detection and launch settings from `src-tauri/src/agents/mod.rs`.

- [ ] **Step 1: Write adapter contract tests**

```rust
#[test]
fn every_registered_provider_has_a_launch_plan_and_explicit_resume_support() {
    for adapter in ProviderRegistry::default().all() {
        let plan = adapter.build_launch(test_launch_request(adapter.id())).expect("launch plan");
        assert!(!plan.program.as_os_str().is_empty());
        let resume = adapter.build_resume(&test_resume(adapter.id())).expect("resume result");
        assert!(resume.is_some() || adapter.resume_support() == ResumeSupport::Unsupported);
    }
}
```

- [ ] **Step 2: Run the test to verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml agents::providers::tests::every_registered_provider_has_a_launch_plan`

Expected: FAIL because the provider adapter trait is not defined.

- [ ] **Step 3: Define the adapter trait**

Include methods `id`, `display_name`, `detect_installation`, `build_launch`, `parse_output`, `detect_resume`, `build_resume`, and `resume_support`. Launch plans must carry program, arguments, cwd, sanitized environment, and an optional provider session hint.

- [ ] **Step 4: Wrap existing provider behavior**

Move provider-specific command construction behind the registry without changing current provider IDs or display names. Unsupported resume returns `ResumeSupport::Unsupported`; it must not fabricate a session ID.

- [ ] **Step 5: Add output and resume fixtures**

Store short provider output fixtures in `src-tauri/src/agents/providers/fixtures/`. Test one recognized start marker, one waiting marker where available, one completed marker, and one unsupported-resume result per adapter.

- [ ] **Step 6: Run checks and commit**

Run: `cargo test --manifest-path src-tauri/Cargo.toml agents::providers`

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

```bash
git add src-tauri/src/agents/providers src-tauri/src/agents/mod.rs src-tauri/src/agents/providers/tests.rs
git commit -m "refactor: isolate provider launch and resume adapters"
```

### Task 3: Add runtime session records and checkpoints

**Files:**
- Create: `src-tauri/src/control/session.rs`
- Create: `src-tauri/src/control/runtime.rs`
- Modify: `src-tauri/src/pty/manager.rs`
- Modify: `src-tauri/src/control/mod.rs`
- Test: `src-tauri/src/control/tests.rs`

**Interfaces:**
- Consumes `ProviderAdapter` from Task 2 and `SnapshotStore` from Task 1.
- Produces `SessionRegistry`, `SessionCheckpoint`, `SessionManager::checkpoint`, `SessionManager::attach`, and `SessionManager::detach`.

- [ ] **Step 1: Write the failing session registry test**

```rust
#[test]
fn detached_session_can_be_found_and_attached_by_session_id() {
    let registry = SessionRegistry::default();
    registry.insert(test_session("session-1", "agent-1"));
    registry.detach("session-1").expect("detach");
    let descriptor = registry.attach("session-1").expect("attach");
    assert_eq!(descriptor.session_id, "session-1");
    assert_eq!(descriptor.agent_id, "agent-1");
}
```

- [ ] **Step 2: Run the test to verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml control::tests::detached_session_can_be_found`

Expected: FAIL because the session registry is not defined.

- [ ] **Step 3: Implement session ownership**

Wrap the existing PTY manager handle in `RuntimeSession`. Store a bounded output ring buffer per session. `attach` registers a terminal sink; `detach` removes the sink without killing the process. `stop` remains the only normal process termination path.

- [ ] **Step 4: Implement checkpoints**

At launch, resize, provider resume discovery, TaxChat mutation, browser navigation, and pane-layout changes, schedule a debounced checkpoint. Persist no more than the configured scrollback limit. Use a generation number so an older asynchronous save cannot overwrite a newer snapshot.

- [ ] **Step 5: Run tests and commit**

Run: `cargo test --manifest-path src-tauri/Cargo.toml control::tests::detached_session_can_be_found`

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

```bash
git add src-tauri/src/control/session.rs src-tauri/src/control/runtime.rs src-tauri/src/pty/manager.rs src-tauri/src/control/mod.rs src-tauri/src/control/tests.rs
git commit -m "feat: add reconnectable runtime sessions"
```

### Task 4: Add supervisor startup, reconnect and reconciliation

**Files:**
- Create: `src-tauri/src/control/supervisor.rs`
- Create: `src-tauri/src/control/reconcile.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/commands.rs`
- Test: `src-tauri/src/control/tests.rs`

**Interfaces:**
- Consumes `SessionRegistry`, `SnapshotStore`, `ProviderRegistry`, and event sequence from earlier tasks.
- Produces `Supervisor::start_or_connect`, `Supervisor::restore_project`, `Supervisor::reconcile`, and `control_session_reconnect`.

- [ ] **Step 1: Write the reconnect test**

```rust
#[test]
fn reconnect_replays_events_after_the_client_cursor_without_duplicate_sessions() {
    let supervisor = test_supervisor();
    supervisor.start_or_connect().expect("start");
    supervisor.restore_project("project-1").expect("restore");
    let first = supervisor.restore_project("project-1").expect("restore again");
    assert_eq!(first.session_ids.len(), 1);
    assert_eq!(first.created_session_ids.len(), 0);
}
```

- [ ] **Step 2: Run the test to verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml control::tests::reconnect_replays_events`

Expected: FAIL because supervisor restore is not defined.

- [ ] **Step 3: Implement startup and reconnect**

Initialize the supervisor before the Tauri window is shown. If a compatible detached supervisor exists, connect to it; otherwise start the local runtime. Reconnect returns the current sequence and a bounded replay after the client cursor.

- [ ] **Step 4: Implement reconciliation**

Compare persisted agent records, runtime sessions, terminal records, and Git worktrees. Mark records without live processes as Offline. Retain missing or dirty worktrees for Storage Manager. Stop untracked processes only when their runtime ownership record proves they belong to ZLI and they are not marked persistent.

- [ ] **Step 5: Add Tauri commands**

Register `control_session_reconnect`, `control_session_snapshot`, `control_session_restore`, and `control_session_resume`. Return stable error codes for missing sessions, unsupported provider resume, and protocol mismatch.

- [ ] **Step 6: Run checks and commit**

Run: `cargo test --manifest-path src-tauri/Cargo.toml control::tests::reconnect_replays_events`

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

```bash
git add src-tauri/src/control/supervisor.rs src-tauri/src/control/reconcile.rs src-tauri/src/lib.rs src-tauri/src/commands.rs src-tauri/src/control/tests.rs
git commit -m "feat: restore and reconcile agent sessions"
```

### Task 5: Connect the frontend restore flow

**Files:**
- Create: `src/stores/sessionStore.ts`
- Modify: `src/stores/workspaceStore.ts`
- Modify: `src/stores/layoutStore.ts`
- Modify: `src/components/Workspace.tsx`
- Test: `tests/sessionRestore.test.mjs`

**Interfaces:**
- Consumes `control_session_reconnect` and `SessionCheckpoint`.
- Produces `useSessionStore`, `restoreSession`, `resumeAgent`, and visible restore states.

- [ ] **Step 1: Write the frontend restore test**

```js
test("restore keeps unsupported provider visible without pretending it resumed", async () => {
  const store = createSessionStoreForTest({ resume: async () => ({ availability: "unsupported" }) });
  await store.restoreSession(checkpointWithAgent("agent-1"));
  assert.equal(store.getState().agents["agent-1"].resumeAvailability, "unsupported");
  assert.equal(store.getState().agents["agent-1"].restoreMessage, "Resume unavailable for this provider");
});
```

- [ ] **Step 2: Run the test to verify failure**

Run: `npm test -- --test-name-pattern="unsupported provider"`

Expected: FAIL because `sessionStore` and restore state do not exist.

- [ ] **Step 3: Implement reconnect initialization**

Connect once during app bootstrap, restore the project tree and pane layout, subscribe from the returned event sequence, and reconcile terminal IDs with current sessions. Keep the selected project and pane focus transient.

- [ ] **Step 4: Implement resume controls**

Show `Resume available`, `Resume unavailable`, `Reconnect`, and `Start new session` as distinct actions. Disable actions while a resume request is pending and render the returned stable error.

- [ ] **Step 5: Run frontend checks and commit**

Run: `npm test -- --test-name-pattern="session"`

Run: `npm run build`

Run: `npm run lint`

```bash
git add src/stores/sessionStore.ts src/stores/workspaceStore.ts src/stores/layoutStore.ts src/components/Workspace.tsx tests/sessionRestore.test.mjs
git commit -m "feat: restore workspace sessions in the UI"
```

### Task 6: Verify durable session behavior

**Files:**
- Modify: `tests/sessionRestore.test.mjs`
- Modify: `src-tauri/src/control/tests.rs`
- Modify: `docs/HANDOFF_CODEX.md`

- [ ] **Step 1: Add end-to-end state cases**

Cover atomic save, schema migration, reconnect without duplicates, bounded scrollback, provider-supported resume, provider-unsupported resume, missing worktree reconciliation, and stale session cleanup.

- [ ] **Step 2: Run the full verification set**

Run: `npm test`

Run: `npm run lint`

Run: `npm run build`

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: all tests pass.

- [ ] **Step 3: Document operational recovery**

Update `docs/HANDOFF_CODEX.md` with supervisor startup, restore behavior, data-directory location, and how Storage Manager handles orphaned or dirty worktrees.

- [ ] **Step 4: Commit**

```bash
git add tests/sessionRestore.test.mjs src-tauri/src/control/tests.rs docs/HANDOFF_CODEX.md
git commit -m "test: verify durable session recovery"
```
