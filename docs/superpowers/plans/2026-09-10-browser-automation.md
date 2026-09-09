# ZLI Browser Automation and Permission Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an authorized agent inspect and operate a project-owned browser surface through the `zli` API while protecting cookies, storage, downloads, and arbitrary JavaScript.

**Architecture:** Keep the existing Tauri WebView2 surface as the renderer. Add a Rust BrowserManager that owns surface identity, project ownership, capability checks, request deadlines, and bounded results. A typed frontend bridge executes approved browser operations on the WebView2 UI thread and returns structured results through request IDs.

**Tech Stack:** Rust 2021, Tauri 2, `serde_json`, React 19, TypeScript 6, Tauri WebView APIs, WebView2 JavaScript evaluation, Zustand 5, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-10-agent-control-plane-design.md`

## Global Constraints

- Browser surfaces belong to one project and optionally one agent.
- Browser commands require a scoped capability.
- `browser.storage`, `browser.download`, and `browser.javascript` are disabled by default.
- Every command has a timeout and bounded output.
- Agents cannot target another project's browser surface.
- Existing browser layout, right-side panel behavior, navigation, and user controls must continue working.
- Browser automation must show loading, empty, permission-denied, timeout, and error states.

## File map

- Create `src-tauri/src/control/browser/mod.rs`: BrowserManager, surface records, command dispatch.
- Create `src-tauri/src/control/browser/security.rs`: browser capability checks and project ownership validation.
- Create `src-tauri/src/control/browser/commands.rs`: typed command and result payloads.
- Create `src-tauri/src/control/browser/tests.rs`: manager and permission tests.
- Modify `src-tauri/src/control/router.rs`: register browser methods.
- Modify `src-tauri/src/commands.rs`: bridge browser request and result commands.
- Modify `src-tauri/src/lib.rs`: register browser control state.
- Create `src/lib/browser/browserProtocol.ts`: frontend command/result types and decoders.
- Create `src/lib/browser/browserBridge.ts`: Tauri event bridge and request correlation.
- Modify `src/components/BrowserPanel.tsx`: register surfaces and execute approved operations.
- Modify `src/stores/uiStore.ts`: persist browser surface/project ownership and permission settings.
- Create `src/components/BrowserPermissionDialog.tsx`: explicit capability grant UI.
- Create `src/components/BrowserAutomationStatus.tsx`: request progress and errors.
- Test: `tests/browserProtocol.test.mjs`, `tests/browserPermissions.test.mjs`, and `tests/browserBridge.test.mjs`.

## Interfaces

```ts
export type BrowserCapability =
  | "browser.read"
  | "browser.interact"
  | "browser.javascript"
  | "browser.storage"
  | "browser.download";

export interface BrowserSurfaceRecord {
  surfaceId: string;
  projectId: string;
  agentId: string | null;
  url: string;
  profileId: string;
  capabilities: BrowserCapability[];
  createdAt: string;
}

export type BrowserCommand =
  | { kind: "open"; url: string }
  | { kind: "navigate"; surfaceId: string; url: string }
  | { kind: "wait"; surfaceId: string; condition: WaitCondition; timeoutMs: number }
  | { kind: "snapshot"; surfaceId: string; selector?: string; maxDepth?: number }
  | { kind: "click"; surfaceId: string; selector: string }
  | { kind: "fill"; surfaceId: string; selector: string; text: string }
  | { kind: "press"; surfaceId: string; key: string }
  | { kind: "eval"; surfaceId: string; script: string }
  | { kind: "console"; surfaceId: string }
  | { kind: "errors"; surfaceId: string }
  | { kind: "screenshot"; surfaceId: string };
```

### Task 1: Define the browser protocol and limits

**Files:**
- Create: `src-tauri/src/control/browser/commands.rs`
- Create: `src/lib/browser/browserProtocol.ts`
- Test: `src-tauri/src/control/browser/tests.rs`
- Test: `tests/browserProtocol.test.mjs`

**Interfaces:**
- Produces typed browser commands, wait conditions, results, stable error codes, and output limits.
- Consumes the control protocol version and capabilities from the API plan.

- [ ] **Step 1: Write the failing protocol test**

```js
test("browser protocol rejects interaction commands without a surface", () => {
  assert.throws(
    () => decodeBrowserCommand({ kind: "click", selector: "#submit" }),
    /surfaceId/,
  );
});

test("browser output limits are explicit", () => {
  assert.equal(BROWSER_LIMITS.maxSnapshotCharacters, 100_000);
  assert.equal(BROWSER_LIMITS.maxScriptCharacters, 20_000);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- --test-name-pattern="browser protocol"`

Expected: FAIL because the browser protocol is not defined.

- [ ] **Step 3: Implement command decoders and limits**

Validate URL schemes, nonempty selectors, allowed key names, script length, snapshot depth, and command deadline. Allow only `http`, `https`, and `about:blank` in the first release. Return `BROWSER_INVALID_COMMAND` instead of throwing raw input.

- [ ] **Step 4: Add Rust serde types**

Mirror the TypeScript wire names with serde. Define result variants for `Surface`, `Navigation`, `Snapshot`, `ConsoleEntries`, `PageErrors`, and `Screenshot`.

- [ ] **Step 5: Run tests and commit**

Run: `npm test -- --test-name-pattern="browser protocol"`

Run: `cargo test --manifest-path src-tauri/Cargo.toml control::browser::tests`

```bash
git add src-tauri/src/control/browser/commands.rs src/lib/browser/browserProtocol.ts src-tauri/src/control/browser/tests.rs tests/browserProtocol.test.mjs
git commit -m "feat: define browser automation protocol"
```

### Task 2: Implement BrowserManager and permission checks

**Files:**
- Create: `src-tauri/src/control/browser/mod.rs`
- Create: `src-tauri/src/control/browser/security.rs`
- Modify: `src-tauri/src/control/router.rs`
- Modify: `src-tauri/src/control/mod.rs`
- Test: `src-tauri/src/control/browser/tests.rs`

**Interfaces:**
- Consumes browser protocol from Task 1, caller identity/capabilities from the API plan, and the event hub.
- Produces `BrowserManager::open`, `BrowserManager::register`, `BrowserManager::authorize`, `BrowserManager::dispatch`, and `BrowserManager::close`.

- [ ] **Step 1: Write permission tests**

```rust
#[test]
fn read_capability_allows_snapshot_but_not_click() {
    let manager = test_browser_manager();
    let surface = manager.register("project-1", Some("agent-1"), "about:blank");
    let read_identity = identity_with(Capability::BrowserRead);
    assert!(manager.authorize(&read_identity, &surface, BrowserCommandKind::Snapshot).is_ok());
    assert_eq!(manager.authorize(&read_identity, &surface, BrowserCommandKind::Click).unwrap_err().code(), "BROWSER_PERMISSION_REQUIRED");
}

#[test]
fn an_agent_cannot_target_a_surface_from_another_project() {
    let manager = test_browser_manager();
    let surface = manager.register("project-2", Some("agent-2"), "about:blank");
    let identity = identity_for_project("project-1", Capability::BrowserRead);
    assert_eq!(manager.authorize(&identity, &surface, BrowserCommandKind::Snapshot).unwrap_err().code(), "BROWSER_SURFACE_FORBIDDEN");
}
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml control::browser::tests::read_capability`

Expected: FAIL because BrowserManager is not defined.

- [ ] **Step 3: Implement surface records and authorization**

Store project ID, optional agent ID, profile ID, URL, capabilities, and timestamps. Authorize project ownership before capability checks. Reject closed or unknown surfaces with `BROWSER_SURFACE_NOT_FOUND`. Reject missing capability with `BROWSER_PERMISSION_REQUIRED`.

- [ ] **Step 4: Implement dispatch deadlines**

Track request ID, surface ID, caller, command kind, and deadline. Reject commands after the deadline. Cap snapshot, console, error, and script results before returning them to the caller.

- [ ] **Step 5: Publish browser events**

Emit `browser.surface_created`, `browser.navigation_changed`, `browser.console_error`, and `browser.command_failed` through the shared event hub. Do not put raw cookies, storage values, or authorization headers in events.

- [ ] **Step 6: Run checks and commit**

Run: `cargo test --manifest-path src-tauri/Cargo.toml control::browser::tests`

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

```bash
git add src-tauri/src/control/browser src-tauri/src/control/router.rs src-tauri/src/control/mod.rs src-tauri/src/control/browser/tests.rs
git commit -m "feat: add browser surface ownership and permissions"
```

### Task 3: Add the WebView2 frontend bridge

**Files:**
- Create: `src/lib/browser/browserBridge.ts`
- Modify: `src/components/BrowserPanel.tsx`
- Modify: `src/tauri/invoke.ts`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `tests/browserBridge.test.mjs`

**Interfaces:**
- Consumes `BrowserManager` requests from Task 2.
- Produces `BrowserBridge.registerSurface`, `BrowserBridge.execute`, `BrowserBridge.closeSurface`, and correlated request results.

- [ ] **Step 1: Write the failing bridge test**

```js
test("bridge resolves the matching request and ignores unrelated results", async () => {
  const bridge = createBrowserBridgeForTest();
  const resultPromise = bridge.execute({ requestId: "req-1", kind: "snapshot", surfaceId: "surface-1" });
  bridge.receive({ requestId: "other", ok: true, result: "ignored" });
  bridge.receive({ requestId: "req-1", ok: true, result: "<main>ready</main>" });
  assert.equal(await resultPromise, "<main>ready</main>");
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test -- --test-name-pattern="bridge resolves"`

Expected: FAIL because the browser bridge is not defined.

- [ ] **Step 3: Implement correlated request handling**

Maintain a `Map<requestId, resolver>` with a deadline timer. Resolve only the matching request, reject timeout with `BROWSER_COMMAND_TIMEOUT`, and reject pending requests when a surface closes. Clean every map entry in success and error paths.

- [ ] **Step 4: Refactor BrowserPanel surface ownership**

Register the created Tauri WebView2 surface with BrowserManager. Keep existing toolbar navigation and resize behavior. Route agent navigation through the same navigation state so the visible browser and persisted browser URL stay synchronized.

- [ ] **Step 5: Implement bounded browser scripts**

Use fixed internal scripts for snapshot, selector interaction, console/error collection, and waiting. Escape selector/text values through JSON serialization. Permit arbitrary JavaScript only when the request has `browser.javascript`.

- [ ] **Step 6: Run checks and commit**

Run: `npm test -- --test-name-pattern="browser bridge"`

Run: `npm run build`

Run: `npm run lint`

```bash
git add src/lib/browser/browserBridge.ts src/components/BrowserPanel.tsx src/tauri/invoke.ts src-tauri/src/commands.rs src-tauri/src/lib.rs tests/browserBridge.test.mjs
git commit -m "feat: bridge browser automation to WebView2"
```

### Task 4: Add explicit browser permission UI and project profiles

**Files:**
- Create: `src/components/BrowserPermissionDialog.tsx`
- Create: `src/components/BrowserAutomationStatus.tsx`
- Modify: `src/stores/uiStore.ts`
- Modify: `src/components/BrowserPanel.tsx`
- Test: `tests/browserPermissions.test.mjs`

**Interfaces:**
- Consumes browser capabilities and command errors from Tasks 1 to 3.
- Produces `grantBrowserCapability`, `revokeBrowserCapability`, and visible command status.

- [ ] **Step 1: Write the permission state test**

```js
test("browser interaction remains disabled until explicitly granted", () => {
  const store = createBrowserPermissionStoreForTest();
  assert.equal(store.can("browser.read"), false);
  store.grant("browser.read");
  assert.equal(store.can("browser.read"), true);
  assert.equal(store.can("browser.interact"), false);
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test -- --test-name-pattern="browser interaction remains"`

Expected: FAIL because browser permission state is not defined.

- [ ] **Step 3: Implement project-scoped settings**

Persist only project ID, surface ID, profile ID, and granted capability names. Default to no agent browser capabilities. Never persist browser cookies or storage values in the ZLI settings record.

- [ ] **Step 4: Implement the permission dialog**

Explain each capability in plain language: read page, click/type, run JavaScript, access storage, download files. Require a deliberate action to grant. Provide revoke actions and show the current project and agent scope.

- [ ] **Step 5: Implement command status**

Show target agent, browser surface, operation, progress, result size, timeout, permission denial, and failure. Keep the status compact and avoid decorative badges without functional meaning.

- [ ] **Step 6: Run checks and commit**

Run: `npm test -- --test-name-pattern="browser permission"`

Run: `npm run build`

Run: `npm run lint`

```bash
git add src/components/BrowserPermissionDialog.tsx src/components/BrowserAutomationStatus.tsx src/stores/uiStore.ts src/components/BrowserPanel.tsx tests/browserPermissions.test.mjs
git commit -m "feat: add explicit browser permissions"
```

### Task 5: Add browser persistence and API integration

**Files:**
- Modify: `src-tauri/src/control/persistence.rs`
- Modify: `src-tauri/src/control/browser/mod.rs`
- Modify: `src-tauri/src/control/router.rs`
- Modify: `src/components/BrowserPanel.tsx`
- Modify: `src/stores/sessionStore.ts`
- Test: `src-tauri/src/control/browser/tests.rs`
- Test: `tests/browserBridge.test.mjs`

**Interfaces:**
- Consumes browser surface and session persistence contracts.
- Produces `browser.open`, `browser.navigate`, `browser.snapshot`, `browser.click`, `browser.fill`, `browser.wait`, `browser.console`, `browser.errors`, and `browser.screenshot` through the shared control router.

- [ ] **Step 1: Write persistence tests**

```rust
#[test]
fn browser_checkpoint_restores_url_but_not_secret_storage() {
    let checkpoint = BrowserCheckpoint::new("surface-1", "project-1", "https://localhost:3000");
    let json = serde_json::to_string(&checkpoint).expect("serialize checkpoint");
    assert!(json.contains("https://localhost:3000"));
    assert!(!json.contains("cookie"));
    assert!(!json.contains("password"));
}
```

- [ ] **Step 2: Run test to verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml control::browser::tests::browser_checkpoint_restores_url`

Expected: FAIL because browser checkpoints are not defined.

- [ ] **Step 3: Persist safe browser state**

Persist surface URL, navigation history metadata, selected tab, profile ID, project ownership, and granted capabilities. Omit cookies, storage and authorization headers unless a future explicit encrypted-profile feature is approved.

- [ ] **Step 4: Register router methods**

Map the public methods to BrowserManager. Return structured results and stable errors. Ensure the browser manager, not the UI, enforces authorization.

- [ ] **Step 5: Run full browser checks**

Run: `cargo test --manifest-path src-tauri/Cargo.toml control::browser::tests`

Run: `npm test -- --test-name-pattern="browser"`

Run: `npm run build`

Run: `npm run lint`

```bash
git add src-tauri/src/control/persistence.rs src-tauri/src/control/browser src-tauri/src/control/router.rs src/components/BrowserPanel.tsx src/stores/sessionStore.ts tests/browserBridge.test.mjs
git commit -m "feat: expose persisted browser control through the API"
```

### Task 6: Verify browser security and user flow

**Files:**
- Modify: `tests/browserProtocol.test.mjs`
- Modify: `tests/browserPermissions.test.mjs`
- Modify: `tests/browserBridge.test.mjs`
- Modify: `src-tauri/src/control/browser/tests.rs`
- Modify: `docs/HANDOFF_CODEX.md`

- [ ] **Step 1: Add security cases**

Cover cross-project targeting, missing capabilities, invalid URL schemes, oversized scripts, oversized snapshots, timeout cleanup, surface close with pending requests, cookie/storage omission, and download denial.

- [ ] **Step 2: Run verification**

Run: `npm test`

Run: `npm run lint`

Run: `npm run build`

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: all checks pass.

- [ ] **Step 3: Document browser control**

Update `docs/HANDOFF_CODEX.md` with the command list, permission defaults, project profile behavior, output limits, and a local test-page example.

- [ ] **Step 4: Commit**

```bash
git add tests/browserProtocol.test.mjs tests/browserPermissions.test.mjs tests/browserBridge.test.mjs src-tauri/src/control/browser/tests.rs docs/HANDOFF_CODEX.md
git commit -m "test: verify browser automation boundaries"
```
