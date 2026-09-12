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

### Not run in this package

- Full `npm test` (entire JS suite)
- `npm run lint` / `npm run build`
- `npm run tauri dev` interactive smoke
- `npm run tauri build` packaged Windows smoke
- Live multi-provider desktop send/receive
- Fixture site through a real WebView2 surface
- Live MCP client against a real Claude/Codex install

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
