# Browser live test - 2026-09-17

Tested the current development build on Windows using `npm run tauri -- dev` and the local browser fixture server on port 4177. Direct browser control used `D:\kh-address`; provider bootstrap checks used `D:\Taxzy_CLI`.

## Results

| Test | Result |
| --- | --- |
| Desktop startup and authenticated `zli health` | Passed |
| `zli browser doctor` | Bridge available; clean-profile control enabled |
| Open fixture in built-in browser | Passed |
| Read form DOM through `browser snapshot` | Passed |
| Fill `#name` with `zli-direct-20260917`, click `#submit` | Passed |
| Read submitted result | Snapshot contained `Form result` and `?name=zli-direct-20260917&note=` |
| Claude Code agent-driven browser task | Blocked before task delivery |
| Codex agent-driven browser task | Blocked before task delivery |
| Other providers, packaged Windows build | Not tested |
| Strict agent-to-browser ownership | Passed in backend and frontend regression tests |
| Runtime Browser Use acceptance phases | Passed in coordinator lifecycle tests |
| Cursor Agent Browser Use acceptance | Blocked at provider workspace-trust confirmation |
| OpenCode Browser Use acceptance | Blocked: provider exited with code 3 before accepting the task; archived diagnostic now available |

## Agent delivery failure

Spawned dedicated `browser-smoke-claude` and `browser-smoke-codex` agents through `zli agent spawn`. Each task instructed the agent to use only ZLI browser tools, submit a provider-specific fixture value, make no file changes, and report an error rather than use another browser.

Both spawn responses reported `mcpProviderConfigured: true` and `mode: mcp`. This is launch configuration evidence, not proof of successful tool discovery or execution by the model.

Repeated queue inspection showed one pending task per agent, zero in-flight tasks, and `readiness.type: unknown`. Terminal output showed Claude at `❯` with placeholder text and Codex at `› Ask Codex to do anything`. Neither test instruction reached the provider. Therefore agent-driven Browser Use did not pass.

The detector in `src-tauri/src/control/prompt_detector.rs:149` compares the ASCII-trimmed line to the bare provider marker. The observed prompt lines include placeholder text; Claude also uses non-ASCII spacing. This is a concrete mismatch with the live output. A fix must retain safeguards against mistaking output text or busy redraws for an input-ready prompt.

Claude also reported an existing missing `gsd-session-state.sh` startup hook and 99% session usage. These are separate constraints; this run was blocked at ZLI task delivery before any model request.

The direct browser test was performed by the test operator, not either AI provider. Do not count it as end-to-end agent acceptance.

Both test agents were stopped after evidence collection. Their worktrees were not force-deleted.

## Implementation follow-up

The prompt-readiness detector now accepts Claude and Codex placeholder prompt rows only when the terminal also emits the cursor-visible control sequence. Bare prompts remain supported, while ordinary output beginning with a prompt marker is still rejected. Regression tests cover all three cases.

The ZLI Browser Use MCP surface now includes Browser Use-compatible names for state inspection, typing, content extraction, tab listing, back navigation, and scrolling. These aliases map to the existing authenticated ZLI browser control service, so providers control the embedded WebView2 pane instead of launching a second browser.

An actual `zli-browser-use` stdio session completed JSON-RPC initialization, listed 17 tools, navigated the embedded browser to the fixture, typed `zli-mcp-compatible` into `#name`, clicked `#submit`, waited for the result URL, and read the submitted value back through `browser_get_state`.

This proves the MCP sidecar to authenticated local IPC to embedded WebView2 path. It does not yet prove model-driven acceptance for every provider. Claude was unavailable on the final host check, and Codex stopped at its own interactive update prompt before reaching its normal input prompt.

## Provider acceptance and ownership follow-up

Browser surfaces now have an exact optional agent owner. An agent may list, reuse, or control only surfaces owned by that same agent; unowned user panes and panes owned by another agent are rejected. Open tickets also bind the expected project and agent, preventing a frontend acknowledgement from attaching the wrong surface. Trusted desktop UI calls retain project-wide access.

Provider capability status now advances from observed runtime events: `configured`, `prompt_ready`, `browser_opened`, `verified`, or `failed`. Configuration alone no longer counts as model acceptance. Evidence records whether a provider prompt, owned browser surface, and completed browser command were actually observed, plus a bounded last error.

Explicit-pull providers now start with no one-shot provider prompt. ZLI writes a generated cookbook into the managed overlay and exposes the absolute `zli agent pull <agent-id>` command in the terminal-facing failure reason, so the provider remains interactive after startup. Cursor reached its own workspace-trust confirmation before it could execute the pull; ZLI intentionally does not auto-approve that security boundary. The earlier OpenCode exit was caused by passing the cookbook through its one-shot `--prompt` path; the managed launch now avoids that path and keeps OpenCode interactive.

The stabilization smoke retested OpenCode and Cursor from a fresh desktop session. OpenCode still exited before provider acceptance, but `zli browser doctor --project D:\Taxzy_CLI --agent <id>` now reports `integrationPhase: failed` with the provider exit code instead of returning `SESSION_NOT_FOUND`. Cursor remained running at its real `Workspace Trust Required` prompt and the attention list marked it `waiting_for_you`; ZLI did not answer the trust prompt automatically. Codex remained running at its own update notice, confirming that the MCP launch path can stay alive even when provider-level setup still needs user action.

## Final verification

- `npm test`: 179 passed, 0 failed.
- `npm run build`: production build completed. Vite still reports existing ineffective dynamic-import warnings.
- `cargo test --manifest-path src-tauri/Cargo.toml -- --test-threads=1`: 220 library tests and 10 CLI tests passed.
- Default parallel `cargo test`: the existing Windows real-PTY isolation test can fail under suite concurrency even though it passes alone and in the sequential suite.
- `zli-browser-use` stdio handshake: server version 0.1.0 exposed 17 tools, including all six Browser Use-compatible additions.
- `git diff --check`: passed.
