# ZLI provider feature matrix

Reference for what WP1-WP7 unit and focused JS tests prove. Cells are not marketing claims.

**Cell values**

- **verified**: covered by an automated test that exercised the behavior (usually with fixtures or stubs)
- **partial**: some path works in tests; live or full provider coverage is missing
- **unsupported**: ZLI code intentionally does not offer the capability
- **not tested**: no automated or recorded live run for this cell

Evidence of runs for this release package is in [`zli-wp8-evidence.md`](./zli-wp8-evidence.md). Fixture pages for browser work are in [`fixtures/browser-site/`](./fixtures/browser-site/).

## Providers

Registered adapters: Claude Code, Codex, Cursor Agent, OpenCode, Gemini CLI, Aider, Goose. Z Code has no adapter.

| Capability | Claude Code | Codex | Cursor Agent | OpenCode | Gemini | Aider | Goose |
|---|---|---|---|---|---|---|---|
| Launch plan / argv construction | verified | verified | verified | verified | partial | partial | partial |
| Executable identity probe | partial | partial | verified | partial | not tested | not tested | not tested |
| MCP Browser Use bind | verified | verified | unsupported | unsupported | unsupported | unsupported | unsupported |
| Shell / cookbook fallback | verified | verified | verified | verified | verified | verified | verified |
| Readiness (glyph slots) | verified | verified | unsupported | unsupported | unsupported | unsupported | unsupported |
| Explicit inbox pull | unsupported | unsupported | verified | verified | partial | partial | partial |
| Send before ready holds | verified | verified | verified | verified | not tested | not tested | not tested |
| Send after idle / prompt | verified | verified | not tested | not tested | not tested | not tested | not tested |
| TaxChat enqueue / deliver | verified | verified | verified | verified | not tested | not tested | not tested |
| Exact resume (session id) | partial | partial | unsupported | unsupported | unsupported | unsupported | unsupported |
| Stop / credential revoke | verified | verified | verified | verified | not tested | not tested | not tested |
| Live desktop send/receive | not tested | not tested | not tested | not tested | not tested | not tested | not tested |
| Packaged Windows smoke | not tested | not tested | not tested | not tested | not tested | not tested | not tested |
| Live browser via ZLI IPC | not tested | not tested | not tested | not tested | not tested | not tested | not tested |

### Notes on the table

**Launch plan.** Every registered provider builds a launch plan in unit tests (`agents::providers::tests`). Gemini, Aider, and Goose use the generic `UnsupportedAdapter` launch path (resume unsupported, ExplicitPull delivery flags). That is launch construction only, not a dedicated lifecycle adapter.

**Identity.** Cursor rejects bare `agent` and verifies `cursor-agent` output in unit tests. Claude and Codex treat a found path as verified without a product probe. Gemini, Aider, and Goose identity against real installs was not run here.

**MCP.** Claude session `--mcp-config` and Codex `-c` overlays bind in `provider_tools` tests. Cursor and OpenCode stay on shell fallback until a verification gate exists. Gemini settings merge, Aider, and Goose never claim MCP (`aider_never_binds_mcp` and recipe map).

**Shell fallback.** Absolute `zli` cookbook / shell binding is unit-tested for shell recipes. Sidecar env injection is covered for managed and direct agents in control tests.

**Readiness.** DeliveryDesk glyph minting and burn-on-input is verified for MintedSlots (Claude, Codex). Cursor and OpenCode are ExplicitPull; pull arming is unit-tested. Gemini/Aider/Goose inherit ExplicitPull contract flags but lack dedicated delivery harness cases.

**Resume.** Session-id parsing rejects prose and accepts validated tokens. Claude and Codex resume command builders exist. Live exact conversation recovery against real CLIs is **not tested**. Cursor, OpenCode, Gemini, Aider, Goose are **unsupported** for exact resume in ZLI.

**TaxChat.** Backend idle glyph and ExplicitPull pending-until-pull are unit-tested. Frontend sends go through `taxchat.send` (no PTY write) and restore hydrates the room. Cross-provider live TaxChat is **not tested**.

## Shared runtime (provider-neutral)

| Area | Status | Evidence |
|---|---|---|
| Managed session / credential lifecycle | verified | `managed_agent_context` unit tests |
| Named pipe concurrency and frame limits | verified | named_pipe + browser frame tests |
| Browser open `requestId` / inactive project | verified | browser unit + JS open-request tests |
| Screenshot within control frame budget | verified | `screenshot_at_character_limit_fits_the_control_frame` |
| WebView2 clean profile path | verified | unit path assertion under app data |
| Keyboard Space → DOM `" "` | verified | executor unit test |
| Shared surface op serialization | verified | browser dispatch unit test |
| Event-log rewrite headroom | verified | event_log rewrite-count test |
| PTY UTF-8 streaming decode | verified | Rust normalizer + JS TextDecoder tests |
| Preference `taxzy:*` → `zli:*` migration | verified | JS preferences tests |
| Worktree `zli/` create / `swarm/` recognize | verified | git workflow + JS worktree tests |
| Sidecar lock refuse overwrite | verified | JS `installSidecarBinary` test |
| Desktop `tauri dev` startup | not tested | manual checklist only |
| Packaged `tauri build` install/run | not tested | manual checklist only |
| Fixture site through live WebView2 | not tested | fixture ready; no live run recorded |

## How to read README claims

README describes intended wiring (scoped env, MCP when bound, shell fallback otherwise). It does not claim every installed provider was proven end-to-end on a desktop or packaged build. Prefer this matrix when a claim about support status is unclear.
