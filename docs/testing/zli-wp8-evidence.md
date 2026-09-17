# WP8 release evidence

Branch: `zli/wp8-release-evidence`  
Date: 2026-09-12  
Plan: `docs/superpowers/plans/2026-09-12-zli-reliability-v2.md` §8  
Synthesis: arena `release-evidence/SYNTHESIS.md`

## Artifacts in this package

| Artifact | Role |
|---|---|
| [`fixtures/browser-site/`](./fixtures/browser-site/) | Static fixture (redirect, form, focus, console, large, slow) |
| [`zli-provider-feature-matrix.md`](./zli-provider-feature-matrix.md) | Honest verified / partial / unsupported / not tested cells |
| This file | Commands actually run and counts |
| Root `README.md` | Claims aligned to the matrix |

## Automated runs (executed)

### Rust lib tests

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib -- --skip prompt_detection_flows
```

Result: **207 passed**, 0 failed, 0 ignored, **2 filtered out** (`prompt_detection_flows`), finished in about 5.9s after compile.

### Focused JS batch

```powershell
node --experimental-strip-types --test `
  tests/browserBridge.test.mjs `
  tests/browserOpenRequest.test.mjs `
  tests/browserNavigation.test.mjs `
  tests/browserUse.test.mjs `
  tests/browserProtocol.test.mjs `
  tests/browserControlUi.test.mjs `
  tests/browserPermissions.test.mjs `
  tests/taxChatCoordinator.test.mjs `
  tests/taxChatStore.test.mjs `
  tests/sessionRestore.test.mjs `
  tests/ptyBridgeOutput.test.mjs `
  tests/preferences.test.mjs `
  tests/worktreePresentation.test.mjs `
  tests/zliSidecar.test.mjs `
  tests/controlCli.test.mjs `
  tests/providerDiagnostics.test.mjs
```

Result: **69 passed**, 0 failed, duration about 0.6s.

### Live smoke (2026-09-13, this machine)

Ran after WP8 land. Not a packaged build.

#### Round 1 (boot / Chromium fixture)

| Check | Result |
|---|---|
| Fixture server `http://127.0.0.1:4177/` | **passed** |
| Redirect / form in Chromium | **passed** |
| `npm run tauri -- dev` boots `zli-desktop.exe` | **passed** |
| Control `endpoint.json` + `zli health` / `browser doctor` | **passed** |
| `browser open` with inactive project | **expected fail** `BROWSER_PROJECT_INACTIVE` |

#### Round 2 (active project `D:\kh-address`, WebView2 CDP + CLI)

Active workspace was already `D:\kh-address` (not Taxzy_CLI). Drove WebView2 with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`.

| Check | Result |
|---|---|
| `zli browser open http://127.0.0.1:4177/redirect.html --project D:\kh-address` | **passed** (surface created) |
| Surface URL after settle | **passed** `…/redirect-target.html` |
| `browser snapshot` shows Redirect target | **passed** |
| Open `/form.html`, `fill #name`, `click #submit` | **passed** URL `form-result.html?name=webview-smoke&note=` |
| `agent spawn --provider claude-code` | **passed** agent running, branch `zli/claude-code-gyt8yh6i`, MCP `mode: mcp` |
| Initial task + `agent send` + `taxchat send` | **partial** messages **queued** (`pendingCount` 2+, `scheduled: false`) while `readiness.type` stayed `unknown` |
| Claude terminal UI | **partial** WebView showed Claude Code + prompt `❯`, plus a non-blocking SessionStart hook error for a missing `gsd-session-state.sh` |
| Delivery into PTY after prompt | **not verified** (queue never drained in this run) |
| Packaged Windows | **not tested** |

Do not treat missing rows as passing.

## Manual smoke checklist (desktop / packaged)

Use this when someone can run the app locally. Leave unchecked until done. Record date and machine in a follow-up note.

### Dev desktop (`npm run tauri dev`)

- [ ] App window title and chrome show ZLI
- [ ] Open a git project; create a managed agent worktree (`zli/` branch)
- [ ] Launch Claude or Codex if installed; confirm terminal output
- [ ] `zli health` from a shell with the scoped PATH returns a healthy envelope
- [ ] Enable built-in browser; serve fixture (`node docs/testing/fixtures/browser-site/serve.mjs`)
- [ ] Navigate to `/redirect.html`; surface ends on `/redirect-target.html`
- [ ] `/form.html` submit reaches `/form-result.html`
- [ ] `/focus.html` Tab moves focus; active id updates
- [ ] `/console.html` shows console noise in the tooling under test
- [ ] `/large.html` screenshot or snapshot stays within documented budgets
- [ ] `/slow.html` waits for delayed `slow.js` under `serve.mjs`
- [ ] TaxChat send from UI stays pending or delivers without a frontend PTY write path
- [ ] Stop agent; credential revoke leaves `zli browser doctor` without a live token

### Packaged Windows (`npm run tauri build`)

- [ ] Installer or portable exe starts
- [ ] Bundled `zli` and `zli-browser-use` resolve for a managed agent
- [ ] Repeat fixture redirect + form under the packaged WebView2
- [ ] AppData still under `com.taxzy.cli` (identifier not migrated in WP6)

## Gaps carried forward

1. Packaged Windows smoke is **not tested**.
2. Live desktop multi-provider acceptance from the plan is **not tested**.
3. Fixture site exists but has **not** been driven through ZLI IPC/WebView2 in this package.
4. Gemini, Aider, Goose remain generic adapters; live behavior is **not tested**.
5. Exact resume against real provider session stores is **partial** at best (parse + command build only).
6. AppData identifier migration remains deferred.
7. Pre-existing `prompt_detection_flows` PTY tests stay skipped.
