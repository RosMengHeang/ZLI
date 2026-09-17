# Provider Browser Acceptance and Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove provider Browser Use per managed agent and enforce strict ownership of every agent-created browser pane.

**Architecture:** Carry the authenticated agent ID through the existing browser open ticket and desktop event pipeline, then require exact ownership in reuse, listing, binding, and authorization. Derive provider acceptance from normalized prompt and browser events already observed by `TeamCoordinator`.

**Tech Stack:** Rust, Tauri 2, TypeScript, React, Zustand, Node test runner

**Spec:** `docs/superpowers/specs/2026-09-17-provider-browser-acceptance-and-ownership-design.md`

## Global Constraints

- `CallerIdentity.agent_id` is the only authority for agent ownership.
- User-created panes remain unowned and are inaccessible to managed agents.
- Redirects may change URLs, so ticket binding validates project and owner, not final URL.
- Provider dialogs requiring consent are reported, never answered automatically.
- No new external dependency is added.
- Existing dirty files unrelated to this phase are preserved.

---

### Task 1: Strict backend browser ownership

**Files:**
- Modify: `src-tauri/src/control/browser/mod.rs`
- Modify: `src-tauri/src/control/browser/security.rs`
- Modify: `src-tauri/src/control/browser/executor.rs`
- Modify: `src-tauri/src/control/service.rs`
- Test: `src-tauri/src/control/browser/tests.rs`

**Interfaces:**
- `BrowserExecutor::request_open(request_id, project_id, agent_id, url)` emits owner identity.
- `BrowserManager::open_and_wait(..., agent_id: Option<&str>, ...)` creates an owned ticket.
- `BrowserManager::find_owned_url(project_id, agent_id, url)` reuses only exact owners.

- [ ] **Step 1: Write failing ownership tests**

Add tests showing that an agent cannot list or authorize unowned/foreign surfaces, same-owner reuse works, and a ticket rejects a wrong-owner binding.

- [ ] **Step 2: Run the focused Rust tests and verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml control::browser::tests -- --test-threads=1`

Expected: failures because list, reuse, tickets, and executor events do not preserve strict ownership.

- [ ] **Step 3: Implement the minimal ownership flow**

Store ticket metadata, propagate `agent_id`, require exact agent ownership for agent callers, and leave trusted non-agent UI access intact.

- [ ] **Step 4: Run the focused Rust tests and verify GREEN**

Run: `cargo test --manifest-path src-tauri/Cargo.toml control::browser::tests -- --test-threads=1`

Expected: all browser manager tests pass.

### Task 2: Preserve ownership through the desktop UI

**Files:**
- Modify: `src/lib/browser/openRequest.ts`
- Modify: `src/lib/browserNavigation.ts`
- Modify: `src/stores/browserStore.ts`
- Modify: `src/components/AppShell.tsx`
- Modify: `src/components/BrowserPanel.tsx`
- Test: `tests/browserOpenRequest.test.mjs`
- Test: `tests/browserNavigation.test.mjs`

**Interfaces:**
- `BrowserOpenRequestPayload.agentId: string | null`
- `BrowserOpenDecision` open variant carries `agentId`.
- `BrowserRequest.agentId?: string | null`
- `pendingOpen` carries `{ requestId, url, agentId }`.

- [ ] **Step 1: Write failing frontend propagation tests**

Assert that active open decisions and `nextBrowserRequest` retain `agentId`, while direct user navigation remains unowned.

- [ ] **Step 2: Run focused Node tests and verify RED**

Run: `node --experimental-strip-types --test tests/browserOpenRequest.test.mjs tests/browserNavigation.test.mjs`

Expected: ownership assertions fail because the payload is currently discarded.

- [ ] **Step 3: Implement the minimal frontend propagation**

Carry `agentId` through the event listener, store, request object, and `registerBrowserSurface` call. Reset to `null` for direct user navigations.

- [ ] **Step 4: Run focused Node tests and verify GREEN**

Run: `node --experimental-strip-types --test tests/browserOpenRequest.test.mjs tests/browserNavigation.test.mjs`

Expected: all focused frontend tests pass.

### Task 3: Runtime provider acceptance evidence

**Files:**
- Modify: `src-tauri/src/control/team.rs`
- Modify: `src-tauri/src/control/tests.rs`

**Interfaces:**
- Add serializable `BrowserIntegrationPhase` with `unavailable`, `configured`, `prompt_ready`, `browser_opened`, `verified`, and `failed`.
- Extend `BrowserAgentCapability` with `integration_phase`, `prompt_observed`, `browser_surface_observed`, `browser_command_observed`, and `last_error`.
- `TeamCoordinator::handle_event` updates evidence only for active project-scoped agents.

- [ ] **Step 1: Write failing lifecycle tests**

Create an agent, emit prompt, owned surface, completed command, failed command, and exit events. Assert each phase transition and cleanup behavior.

- [ ] **Step 2: Run focused coordinator tests and verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml browser_integration -- --test-threads=1`

Expected: tests fail because runtime acceptance evidence does not exist.

- [ ] **Step 3: Implement bounded evidence and phase derivation**

Use one `Mutex<HashMap<String, BrowserIntegrationEvidence>>`, update it from normalized events, expose only booleans and bounded error text, and remove entries during cleanup.

- [ ] **Step 4: Run focused coordinator tests and verify GREEN**

Run: `cargo test --manifest-path src-tauri/Cargo.toml browser_integration -- --test-threads=1`

Expected: all integration evidence tests pass.

### Task 4: Provider acceptance matrix and live smoke verification

**Files:**
- Modify: `docs/testing/zli-provider-feature-matrix.md`
- Modify: `docs/testing/zli-browser-live-2026-09-17.md`

**Interfaces:**
- Each provider records installation, binding mode, prompt evidence, owned surface evidence, completed browser command evidence, and blocker.

- [ ] **Step 1: Build the sidecars and production frontend**

Run: `cargo build --manifest-path src-tauri/Cargo.toml --bin zli --bin zli-browser-use`

Run: `npm run build`

- [ ] **Step 2: Run installed providers independently**

For Codex, Cursor Agent, and OpenCode, launch one managed agent and request a local fixture interaction. Do not bypass ZLI with another browser tool. Record update, login, or unsupported-MCP blockers as provider blockers.

- [ ] **Step 3: Record truthful per-provider results**

Mark a provider verified only after an owned `BrowserCommandCompleted` event. Missing Claude, Gemini, or Aider installations remain untested, not failed.

### Task 5: Full regression gate

**Files:**
- Verify all files modified above.

- [ ] **Step 1: Run JavaScript tests**

Run: `npm test`

Expected: 0 failures.

- [ ] **Step 2: Run Rust tests sequentially on Windows**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -- --test-threads=1`

Expected: 0 failures. Sequential mode avoids the known Windows real-PTY concurrency flake.

- [ ] **Step 3: Run production build and diff checks**

Run: `npm run build`

Run: `git diff --check`

Expected: both exit successfully.

- [ ] **Step 4: Verify MCP catalog**

Initialize `zli-browser-use` over stdio and call `tools/list`.

Expected: the server identifies itself as `zli-browser-use` and exposes the Browser Use-compatible tools.
