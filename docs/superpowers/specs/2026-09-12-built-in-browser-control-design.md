# Built-in Browser Control Design

**Status:** Proposed for review  
**Date:** 2026-09-12  
**Scope:** ZLI desktop app, local `zli` CLI, embedded Tauri WebView2 browser

## Goal

Add a first-class `Enable built-in browser control` setting so ZLI can expose its embedded browser to new agent sessions in the same product shape as Codex. The CLI should be able to request a browser preview, receive a stable browser surface ID, and control that surface through the existing authenticated local control plane without requiring a Chrome extension. A provider-neutral Browser Use gateway will expose the same browser contract to Claude, Codex, Cursor, Z Code, and future providers.

OpenAI documents two separate experiences: an isolated built-in browser in the desktop app, and an extension-backed connection for existing Chrome, Edge, Brave, Opera, or Vivaldi sessions. ZLI will implement the isolated built-in experience first. See the [official browser documentation](https://learn.chatgpt.com/docs/browser) and [browser extension documentation](https://learn.chatgpt.com/docs/chrome-extension).

## Product behavior

### Settings

Add a Browser section to `Preferences` with one master switch:

```text
Enable built-in browser control
Allow new agent sessions to open, inspect, and control pages in ZLI's built-in browser.
```

The switch is persisted per local ZLI installation and browser profile. It is on by default for a new clean ZLI browser profile. A clean profile is an isolated ZLI-managed profile with its own cookies, storage, history, and downloads; it does not import the user's normal Chrome session. Turning the switch off immediately blocks new automated browser operations but does not close the visible browser pane or delete its history.

### New browser sessions

When the switch is enabled, including the default state of a clean profile, a new embedded browser surface is created with the normal project and profile ownership rules. The surface inherits `browser.read` and `browser.control` for the active project and clean profile so a new session can preview and operate a page without a second setup step. `browser.javascript`, storage, and download access remain separately disabled until explicitly granted.

The existing Browser access dialog remains the advanced permission editor. Revoking a capability there overrides the inherited default for that project and profile. Turning the master switch off overrides every surface for agent automation until it is enabled again.

### CLI behavior

```text
zli browser status
zli browser open http://localhost:3000 --project D:\\repo
zli browser list --json
zli browser snapshot <surface-id>
zli browser click <surface-id> --selector "#submit"
```

`zli browser status` reports whether the ZLI desktop bridge is reachable, whether built-in browser control is enabled, and how many browser surfaces are registered. `browser open` requests a ZLI-owned WebView2 surface; it never searches for or attaches to an unrelated Chrome window.

When control is disabled, preview surface creation remains available to a local user request, but agent read/control commands return a stable `BROWSER_CONTROL_DISABLED` error with an instruction to enable the setting. No command silently falls back to another browser.

## Provider-neutral Browser Use

Browser Use is a ZLI capability, not a provider-specific browser integration. The desktop app owns the embedded browser, while every managed provider uses the same authenticated gateway and operation schema:

```text
Claude / Codex / Cursor / Z Code / future provider
                         |
                         v
              ZLI Browser Use gateway
                         |
                         v
                  BrowserManager
                         |
                         v
                 Embedded WebView2
```

When ZLI starts a managed agent session, it provides a scoped browser identity through the existing control environment:

```text
ZLI_CONTROL_ENDPOINT
ZLI_CONTROL_TOKEN
ZLI_PROJECT_ID
ZLI_BROWSER_PROFILE=clean
ZLI_BROWSER_SESSION=<session-id>
```

Providers that support MCP receive a local ZLI Browser Use MCP adapter. The adapter translates provider tool calls such as `browser_open`, `browser_snapshot`, `browser_click`, and `browser_screenshot` into the versioned ZLI control methods. Providers that do not support MCP can use the existing `zli browser ...` CLI commands with the same scoped identity. Both paths reach the same backend authorization and the same visible browser surface.

The provider adapter must not own cookies, create another browser, or bypass `BrowserManager`. It only translates the common tool contract. Adding a provider therefore means adding a launch/environment adapter, not writing another browser automation implementation.

The first-release common tool contract is:

```text
browser_status
browser_open
browser_navigate
browser_wait
browser_snapshot
browser_click
browser_fill
browser_press
browser_console
browser_errors
browser_screenshot
```

`browser_eval` remains an elevated operation and is not exposed to new provider adapters by default. JavaScript access requires the separate `browser.javascript` capability.

### Browser pane

The browser remains a docked pane beside the terminal layout. Its toolbar shows a compact state indicator:

```text
Browser control enabled
Browser control disabled
Waiting for ZLI desktop app
```

The indicator is functional status, not decoration. It opens Preferences when the setting is disabled and provides the relevant error when the bridge is unavailable.

## Architecture

```text
Preferences switch
        |
        v
BrowserControlSettingsStore <----> ControlService / Tauri command
        |
        v
Provider CLI or local MCP adapter
        |
        v
BrowserManager master gate
        |
        +--> project/profile capability checks
        |
        v
Browser executor on the WebView2 UI thread
        |
        v
Embedded browser surface in the docked pane
```

The backend remains authoritative. The React store may mirror the setting for rendering, but it must not be trusted to authorize a CLI request. `BrowserManager` checks the master setting before its existing surface and capability checks.

### Settings store

Create a focused Rust settings component owned by the control layer. Store a versioned JSON document under the existing app data control directory:

```json
{
  "schemaVersion": 1,
  "profiles": {
    "clean": {
      "builtInBrowserControlEnabled": true
    }
  }
}
```

Writes must be atomic and tolerant of a missing or corrupt file. A missing `clean` profile setting resolves to the product default, enabled. A corrupt settings document resolves to a safe disabled state and shows a recovery message rather than silently granting access. The component exposes typed `get(profile_id)`, `set(profile_id, enabled)`, and `is_enabled(profile_id)` methods and does not know about React, WebView2, provider CLIs, or MCP.

### Control protocol

Add these methods to the versioned local control protocol:

```text
browser.status
browser.control_status
browser.control_set
browser.use
```

`browser.status` is read-only and returns bridge availability, control state, active profile, and surface count. `browser.control_status` is the typed settings read used by the desktop UI. `browser.control_set` is limited to the local desktop identity and changes the persisted master setting. `browser.use` is the provider-neutral gateway method used by the local MCP adapter; it accepts only the common tool contract and dispatches to the same typed browser methods. Managed agents and arbitrary project-scoped callers cannot change the setting.

The existing capability map remains the second authorization layer:

```text
global browser control enabled
        AND
caller has browser capability
        AND
surface belongs to caller project
        AND
operation-specific capability is granted
```

For newly created built-in surfaces, `browser.read` and `browser.control` are inherited only when the master switch is enabled. Explicit revocations are stored per project/profile and are never overwritten by a later surface registration.

### Surface lifecycle

1. The Tauri app starts the authenticated current-user named pipe and writes `endpoint.json`.
2. The CLI reads the endpoint file and performs the existing protocol handshake.
3. `zli browser open` sends a project-scoped open request.
4. The desktop UI creates the native WebView2 child surface and registers its label with `BrowserManager`.
5. `BrowserManager` returns a stable `surfaceId` and effective capabilities.
6. Later CLI operations target that `surfaceId` through the same named pipe.
7. `BrowserManager` enforces the master switch, project ownership, capability, timeout, and output limits before dispatching to the WebView2 executor.
8. The desktop UI publishes navigation, completion, and failure events through the existing event hub.

If the desktop app is not running, CLI discovery fails with a clear `ZLI_DESKTOP_UNAVAILABLE` error. If the app is running but browser control is disabled, the CLI receives `BROWSER_CONTROL_DISABLED`. These are different failures and must remain distinguishable in human and JSON output.

## File boundaries

### Create

- `src-tauri/src/control/browser/settings.rs`: versioned persisted master setting and atomic file writes.
- `src-tauri/src/control/browser/use_gateway.rs`: provider-neutral Browser Use request decoding and dispatch to typed browser methods.
- `src-tauri/src/bin/zli-browser-use.rs`: local MCP adapter for providers that support MCP, using the managed session token and the common tool contract.
- `src/components/BrowserControlStatus.tsx`: compact browser-control state and preference entry point if the existing status component is not a suitable home.

### Modify

- `src-tauri/src/control/browser/mod.rs`: load settings, expose status, inherit new-surface capabilities, and enforce the master gate.
- `src-tauri/src/control/protocol.rs`: add browser status/control methods and stable error codes.
- `src-tauri/src/control/router.rs`: map new methods to read-only or local-settings capabilities.
- `src-tauri/src/control/service.rs`: route status and settings commands.
- `src-tauri/src/lib.rs`: register Tauri commands and initialize the settings store from app data.
- `src/control/protocol.ts`: mirror method and response types.
- `src/control/cli.ts`: parse `zli browser status` and optional JSON output.
- `src/control/browserUse.ts`: shared provider-facing tool names and result types used by the CLI and MCP adapter.
- `src/components/PreferencesDialog.tsx`: render and update the master switch.
- `src/components/BrowserPanel.tsx`: show the authoritative state and keep the native pane layout unchanged.
- `src/stores/browserStore.ts`: mirror status, refresh after setting changes, and preserve per-surface overrides.
- `src/lib/browser/browserBridge.ts`: add typed status and setting calls.
- `tests/controlCli.test.mjs`: cover CLI parsing for browser status.
- `tests/browserProtocol.test.mjs`: cover stable disabled-control error decoding and status validation.
- Rust control tests: cover setting persistence, safe defaults, local-only mutation, capability inheritance, and master-gate enforcement.

## Error handling and security

- The backend, not the frontend, makes the authorization decision.
- The clean profile defaults to enabled when its setting is absent. A corrupt settings document disables control until repaired.
- The clean browser profile is isolated from normal Chrome profiles and never imports existing cookies by default.
- Disabling control does not delete browser data, close surfaces, or kill agent terminals.
- In-flight operations are not granted new permission after a setting change. New dispatches fail immediately; the existing request timeout remains the upper bound for an operation already executing.
- JavaScript, storage, downloads, cookies, and authentication headers remain outside the master switch and require explicit operation-specific permissions.
- Browser content remains untrusted context. Page text cannot change the ZLI setting or grant itself permissions.
- Provider adapters cannot bypass the Browser Use gateway, use another project's surface, or change the master setting.
- No external browser connection is added in this change. Chrome control remains a future extension/CDP connector with a separate consent flow.

## Verification

### Unit tests

- Missing settings file resolves to disabled.
- Corrupt settings file resolves to disabled without crashing startup.
- Atomic save and reload preserve the switch.
- Non-local callers cannot mutate the switch.
- Disabled control rejects snapshot, click, fill, press, screenshot, console, and errors with `BROWSER_CONTROL_DISABLED`.
- Enabling control allows new surfaces to inherit read/control capabilities.
- Explicit project/profile revocation still wins over inherited defaults.
- `zli browser status` produces stable human and JSON output.

### Integration checks

```powershell
npm test
npm run lint
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml -j 1
cargo check --manifest-path src-tauri/Cargo.toml -j 1
git diff --check
```

### Manual acceptance

1. Start ZLI with `npm run tauri dev`.
2. Open Preferences on a clean profile and verify the new switch is on.
3. Run `zli browser status` and verify it reports the desktop bridge, clean profile, and enabled control.
4. Open a local page and verify the user can preview it.
5. Verify a managed Claude, Codex, Cursor, or Z Code session receives the scoped Browser Use capability.
6. Verify the CLI and MCP adapter produce the same snapshot and click results for the same surface.
7. Disable the switch and verify the pane remains visible while new agent operations are denied.
8. Close and reopen ZLI and verify the setting, browser profile, and browser URL persist.

## Deliberate non-goals

- Installing or copying OpenAI's private Browser Use plugin into ZLI.
- Attaching to arbitrary existing Chrome tabs.
- Reimplementing browser automation separately for each provider.
- Automatically granting JavaScript, storage, downloads, or browser history access.
- Moving the browser into a popup or separate top-level window.
- Replacing the existing project-scoped surface ownership model.
