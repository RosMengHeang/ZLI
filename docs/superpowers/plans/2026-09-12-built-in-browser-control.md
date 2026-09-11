# Built-in Browser Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a clean-profile browser control switch, a provider-neutral Browser Use gateway, and reliable CLI discovery for the ZLI embedded browser.

**Architecture:** Keep the Tauri WebView2 child surface as the only built-in browser renderer. Put the new master setting and authorization gate in Rust, expose typed status/control methods through the existing authenticated named pipe, and provide a small stdio MCP adapter that forwards provider tool calls to the same control methods. Managed agents also receive a scoped `zli` command fallback and a compatibility report.

**Tech Stack:** Rust 2021, Tauri 2, WebView2, serde/serde_json, authenticated Windows named pipe, React 19, TypeScript 6, Zustand 5, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-12-built-in-browser-control-design.md`

## Global Constraints

- The clean browser profile defaults to built-in control enabled; corrupt settings disable control.
- The embedded browser stays isolated from the user's regular Chrome profile.
- Browser authorization is enforced by Rust and cannot rely on React state.
- Existing project/profile capabilities remain the second authorization layer.
- JavaScript, storage, and downloads remain explicitly gated.
- No external Chrome integration is implemented in this plan.
- Provider support is reported by capability, never assumed from the provider name.
- All browser outputs remain bounded by the existing browser protocol limits.

---

### Task 1: Add the persisted browser control settings domain

**Files:**
- Create: `src-tauri/src/control/browser/settings.rs`
- Modify: `src-tauri/src/control/browser/mod.rs`
- Modify: `src-tauri/src/control/mod.rs`
- Test: `src-tauri/src/control/tests.rs`

**Interfaces:**
- Produces `BrowserControlSettingsStore::open(control_dir)`, `get(profile_id)`, `is_enabled(profile_id)`, and `set_enabled(profile_id, enabled)`.
- Produces `BrowserControlSettings { schema_version, profiles }` and `BrowserProfileSettings { built_in_browser_control_enabled }`.
- `BrowserManager` consumes the settings store through an `Arc<BrowserControlSettingsStore>`.

- [ ] **Step 1: Write the failing settings tests**

Add Rust tests covering a missing file resolving to an enabled `clean` profile, corrupt JSON resolving to disabled control, atomic save/reload, and separate values for `clean` and another profile. Use `tempfile::tempdir()` and a settings file under the temporary `control` directory.

- [ ] **Step 2: Run the focused Rust tests and verify they fail**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml control::tests::browser_control_settings -j 1
```

Expected: compilation or test failure because the settings store does not exist.

- [ ] **Step 3: Implement the settings store**

Use a `Mutex<BrowserControlSettings>` and a file path. Read `settings.json` during `open`. If the file is absent, create an in-memory version 1 document with `clean.builtInBrowserControlEnabled = true`. If decoding or validation fails, use an in-memory disabled document and retain a recoverable error state for the UI. Save to `settings.json.tmp`, flush and close it, then rename it over the destination. Do not expose filesystem details to browser commands.

- [ ] **Step 4: Connect the store to `BrowserManager`**

Add the settings store to `BrowserManager` construction and expose `control_enabled(profile_id)`. Keep the existing profile capability map in `BrowserManager`; the new store is only the master feature gate and profile default source.

- [ ] **Step 5: Run the focused tests**

Run the same focused command and expect all settings tests to pass.

- [ ] **Step 6: Commit the settings boundary**

```powershell
git add src-tauri/src/control/browser/settings.rs src-tauri/src/control/browser/mod.rs src-tauri/src/control/mod.rs src-tauri/src/control/tests.rs
git commit -m "feat: persist built-in browser control settings"
```

### Task 2: Extend the control protocol and backend authorization

**Files:**
- Modify: `src-tauri/src/control/protocol.rs`
- Modify: `src-tauri/src/control/router.rs`
- Modify: `src-tauri/src/control/service.rs`
- Modify: `src-tauri/src/control/browser/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/control/protocol.ts`
- Modify: `src/lib/browser/browserProtocol.ts`
- Test: `tests/browserProtocol.test.mjs`
- Test: `src-tauri/src/control/tests.rs`

**Interfaces:**
- Adds `ControlMethod::BrowserStatus`, `BrowserControlStatus`, `BrowserControlSet`, and `BrowserUse` with stable serialized names.
- Adds `ControlErrorCode::BrowserControlDisabled`.
- Produces a `BrowserRuntimeStatus` response containing `bridgeAvailable`, `controlEnabled`, `profileId`, and `surfaceCount`.
- `BrowserManager::authorize` rejects read/control operations when the master setting is disabled, while preserving existing surface/project/caller checks.

- [ ] **Step 1: Write failing protocol and authorization tests**

Add tests that decode `BROWSER_CONTROL_DISABLED`, reject browser snapshot and click when the clean profile master setting is disabled, allow them when enabled and capability-granted, and return a stable browser status object.

- [ ] **Step 2: Run focused tests and verify failure**

```powershell
npm test -- --test-name-pattern="browser protocol|browser control"
cargo test --manifest-path src-tauri/Cargo.toml control::tests::browser -j 1
```

Expected: failures because the new protocol variants and gate are not defined.

- [ ] **Step 3: Add Rust protocol variants and error code**

Add the methods to the Rust enum, map them in `capability_for`, and add `BrowserControlDisabled` to the error enum and `as_str`. Keep `browser.control_set` restricted to the desktop UI identity inside the handler; do not add a general agent capability that can mutate settings.

- [ ] **Step 4: Add backend status and setting handlers**

Extend `RuntimeControlHandler` with read-only status and control-status responses. For control-set, validate the profile ID, require the UI identity, persist the requested value, and return the updated status. Add a `BrowserUse` handler that accepts a bounded operation name and parameters, converts it to the existing typed browser command, and reuses `BrowserManager` authorization rather than dispatching arbitrary JSON.

- [ ] **Step 5: Enforce the master gate in `BrowserManager`**

Check the surface profile before `security::authorize_surface`. Return `BROWSER_CONTROL_DISABLED` for read/control/javascript operations when the profile switch is off. Keep `browser.open` available only through the local user/desktop request path; a managed agent open request must pass the same master gate and project authorization.

- [ ] **Step 6: Mirror TypeScript protocol types**

Add the new method names, error code, and status/result interfaces to the TypeScript protocol modules without weakening existing command validation.

- [ ] **Step 7: Run focused tests and commit**

```powershell
npm test -- --test-name-pattern="browser protocol|browser control"
cargo test --manifest-path src-tauri/Cargo.toml control::tests::browser -j 1
git add src-tauri/src/control/protocol.rs src-tauri/src/control/router.rs src-tauri/src/control/service.rs src-tauri/src/control/browser/mod.rs src-tauri/src/lib.rs src/control/protocol.ts src/lib/browser/browserProtocol.ts tests/browserProtocol.test.mjs src-tauri/src/control/tests.rs
git commit -m "feat: gate browser automation through control settings"
```

### Task 3: Add CLI browser status and Browser Use stdio adapter

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/control/browser/use_gateway.rs`
- Create: `src-tauri/src/bin/zli_browser_use.rs`
- Modify: `src-tauri/src/control/mod.rs`
- Modify: `src-tauri/src/bin/zli.rs`
- Modify: `src/control/cli.ts`
- Modify: `src/control/protocol.ts`
- Create: `src/control/browserUse.ts`
- Test: `tests/controlCli.test.mjs`
- Test: `src-tauri/src/control/tests.rs`

**Interfaces:**
- Produces `zli browser status` with human-readable and `--json` output.
- Produces `zli browser doctor --agent <agent-id>` with explicit checks for endpoint, token, profile, executable, and MCP adapter availability.
- Produces a stdio JSON-RPC adapter executable named `zli-browser-use` with `initialize`, `notifications/initialized`, `tools/list`, and `tools/call` support.
- MCP tool names map to `browser_status`, `browser_open`, `browser_navigate`, `browser_wait`, `browser_snapshot`, `browser_click`, `browser_fill`, `browser_press`, `browser_console`, `browser_errors`, and `browser_screenshot`.

- [ ] **Step 1: Write failing CLI parser and gateway tests**

Add TypeScript parser tests for `zli browser status` and `zli browser doctor --agent agent-1`. Add Rust tests for tool-list contents, unknown-tool rejection, bounded argument decoding, and forwarding a valid request to a mock control handler.

- [ ] **Step 2: Run focused tests and verify failure**

```powershell
npm test -- --test-name-pattern="control CLI|browser use"
cargo test --manifest-path src-tauri/Cargo.toml control::tests::browser_use -j 1
```

Expected: failures because the new commands and gateway do not exist.

- [ ] **Step 3: Implement `browser status` and `browser doctor`**

Use the existing endpoint discovery and named-pipe request path. `status` must distinguish desktop unavailable, protocol mismatch, disabled control, and a healthy bridge. `doctor` must not start or kill an agent; it reads the current scoped environment and reports each check independently.

- [ ] **Step 4: Implement the common Browser Use gateway**

Define typed tool metadata and a decoder that maps each tool to one existing `ControlMethod`. Reject tools outside the approved list, scripts, unbounded text, missing surface IDs, and malformed parameters before any pipe request. Return JSON-RPC errors that preserve the ZLI stable error code.

- [ ] **Step 5: Implement the stdio adapter**

Read one JSON-RPC object per line from stdin, write one response per line to stdout, and write diagnostics only to stderr. `initialize` returns protocol and server metadata. `tools/list` returns the common tool schemas. `tools/call` sends an authenticated `ControlRequest` over the existing named pipe using `ZLI_CONTROL_ENDPOINT` and `ZLI_CONTROL_TOKEN`, then returns the bounded control result. Never log tokens, page content, cookies, or screenshots.

- [ ] **Step 6: Register the binary**

Add the `zli-browser-use` binary target without changing the default `zli` binary. Keep the adapter usable from a managed agent's inherited PATH and from a direct absolute path reported by `zli browser doctor`.

- [ ] **Step 7: Run focused tests and commit**

```powershell
npm test -- --test-name-pattern="control CLI|browser use"
cargo test --manifest-path src-tauri/Cargo.toml control::tests::browser_use -j 1
git add src-tauri/Cargo.toml src-tauri/src/control/browser/use_gateway.rs src-tauri/src/bin/zli_browser_use.rs src-tauri/src/control/mod.rs src-tauri/src/bin/zli.rs src/control/cli.ts src/control/protocol.ts src/control/browserUse.ts tests/controlCli.test.mjs src-tauri/src/control/tests.rs
git commit -m "feat: add provider-neutral browser use gateway"
```

### Task 4: Wire managed agent sessions to browser discovery

**Files:**
- Modify: `src-tauri/src/control/team.rs`
- Modify: `src-tauri/src/agents/manager.rs`
- Modify: `src-tauri/src/control/service.rs`
- Modify: `src-tauri/src/control/browser/mod.rs`
- Test: `src-tauri/src/control/tests.rs`
- Test: `tests/agentControl.test.mjs`

**Interfaces:**
- Managed sessions receive `ZLI_BROWSER_PROFILE=clean`, `ZLI_BROWSER_SESSION`, and `ZLI_BROWSER_USE_COMMAND` alongside the existing control endpoint and token.
- Provider launch metadata reports whether MCP configuration is available, shell fallback is available, and the provider is unsupported.
- `agent.spawn` returns the browser capability summary without exposing the token.

- [ ] **Step 1: Write failing environment and compatibility tests**

Test that a child launch environment contains the clean profile, session ID, and adapter command; that credentials are not included in serialized agent responses; and that a provider without a registered adapter is reported as shell-fallback or unsupported rather than MCP-ready.

- [ ] **Step 2: Run the focused tests and verify failure**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml control::tests::agent_browser_environment -j 1
npm test -- --test-name-pattern="agent control"
```

- [ ] **Step 3: Add scoped browser environment values**

Extend `control_environment` with the clean profile, a per-agent browser session ID, and the absolute `zli-browser-use` command path. Preserve the existing token scope and expiry. Use the agent ID and project ID to prevent cross-project surface access.

- [ ] **Step 4: Add provider capability reporting**

Create a small provider capability table keyed by canonical provider ID. Mark MCP as available only when the provider launch path can consume the adapter configuration. Mark shell fallback when the provider can run the inherited `zli` executable. Keep unknown providers visible as unsupported and expose the reason in `doctor` output.

- [ ] **Step 5: Add launch instructions without relying on prompt-only discovery**

For shell fallback providers, inject a short provider task context that names the scoped command and `zli browser status`. For MCP-capable providers, pass the adapter command through their supported configuration mechanism. Do not claim MCP support until the provider adapter confirms that configuration was accepted.

- [ ] **Step 6: Run focused tests and commit**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml control::tests::agent_browser_environment -j 1
npm test -- --test-name-pattern="agent control"
git add src-tauri/src/control/team.rs src-tauri/src/agents/manager.rs src-tauri/src/control/service.rs src-tauri/src/control/browser/mod.rs src-tauri/src/control/tests.rs tests/agentControl.test.mjs
git commit -m "feat: expose scoped browser capability to agents"
```

### Task 5: Add Preferences and browser-pane status UI

**Files:**
- Modify: `src/lib/browser/browserBridge.ts`
- Modify: `src/stores/browserStore.ts`
- Modify: `src/components/PreferencesDialog.tsx`
- Modify: `src/components/BrowserPanel.tsx`
- Create or modify: `src/components/BrowserControlStatus.tsx`
- Test: `tests/browserBridge.test.mjs`
- Test: `tests/uiDesignContract.test.mjs`

**Interfaces:**
- `browserBridge` exposes typed `getControlStatus()` and `setControlEnabled(profileId, enabled)` calls.
- `browserStore` exposes `controlStatus`, `refreshControlStatus()`, and `setControlEnabled()`.
- Preferences renders the exact label `Enable built-in browser control` and a real switch.

- [ ] **Step 1: Write failing frontend tests**

Test that bridge calls use the correct Tauri command names and payloads, the store mirrors the backend status, and the Preferences dialog contains the switch label, description, enabled state, and disabled-state recovery action.

- [ ] **Step 2: Run focused tests and verify failure**

```powershell
npm test -- --test-name-pattern="browser bridge|browser control|Preferences"
```

- [ ] **Step 3: Implement bridge and store methods**

Load status on browser-panel mount and preferences open. Keep loading and error states explicit. After a successful toggle, update the status from the backend response instead of assuming the local value.

- [ ] **Step 4: Add the Preferences switch**

Use the existing project component conventions. The switch must be keyboard reachable, show a visible focus state, disable itself while saving, and report backend errors. Explain that the clean profile is isolated and that JavaScript/storage/download access remains separately controlled.

- [ ] **Step 5: Add the browser-pane indicator**

Show `Browser control enabled`, `Browser control disabled`, or `Waiting for ZLI desktop app` based on actual store state. Clicking the disabled state opens Preferences. Do not add decorative badges or duplicate status text elsewhere.

- [ ] **Step 6: Run focused tests and commit**

```powershell
npm test -- --test-name-pattern="browser bridge|browser control|Preferences"
npm run test:ui
git add src/lib/browser/browserBridge.ts src/stores/browserStore.ts src/components/PreferencesDialog.tsx src/components/BrowserPanel.tsx src/components/BrowserControlStatus.tsx tests/browserBridge.test.mjs tests/uiDesignContract.test.mjs
git commit -m "feat: add built-in browser control setting"
```

### Task 6: Register the settings store and finish end-to-end verification

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/control/service.rs`
- Modify: `src-tauri/src/control/mod.rs`
- Modify: `README.md`
- Modify: `docs/HANDOFF_CODEX.md`
- Test: all existing frontend and Rust tests

**Interfaces:**
- Tauri startup owns one settings store under the existing app data `control` directory.
- The UI and named-pipe router share the same `BrowserManager` and settings store.
- README documents the browser status, preview, and provider discovery commands.

- [ ] **Step 1: Write the startup wiring test**

Add a Rust construction test that initializes a temporary control directory, creates the settings store and BrowserManager, and verifies the clean profile status is enabled before any browser surface exists.

- [ ] **Step 2: Wire startup and Tauri commands**

Initialize the settings store before creating BrowserManager, manage both in Tauri state, pass the store into `RuntimeControlHandler`, and register typed Tauri commands for status and control-set. Keep the existing browser surface registration commands unchanged for compatibility.

- [ ] **Step 3: Update operator documentation**

Document that `npm run tauri dev` starts the desktop bridge, that `zli browser status` checks it, that `zli browser open` opens the embedded pane, and that provider support is verified with `zli browser doctor`. State clearly that a prompt alone does not install browser tools into an arbitrary CLI.

- [ ] **Step 4: Run the complete verification set**

```powershell
npm install
npm test
npm run lint
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml -j 1
cargo check --manifest-path src-tauri/Cargo.toml -j 1
git diff --check
```

- [ ] **Step 5: Manually verify the clean-profile flow**

Start `npm run tauri dev`, confirm Preferences shows the switch enabled for a clean profile, run `zli browser status`, open `http://localhost:3000`, obtain the surface ID with `zli browser list --json`, and verify snapshot/click/screenshot. Disable the switch and verify the visible pane remains while agent operations return `BROWSER_CONTROL_DISABLED`.

- [ ] **Step 6: Manually verify provider discovery**

For each installed managed provider, run `zli browser doctor --agent <agent-id>` and record whether it is MCP-ready, shell-fallback, or unsupported. Do not mark a provider as fully supported until the agent can open the page and return a snapshot through the same surface.

- [ ] **Step 7: Commit the integration and report evidence**

```powershell
git add src-tauri/src/lib.rs src-tauri/src/control/service.rs src-tauri/src/control/mod.rs README.md docs/HANDOFF_CODEX.md
git commit -m "docs: finish built-in browser control integration"
git status --short --branch
```

