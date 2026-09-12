# ZLI Cross-Provider Reliability Implementation Plan — Second Audit

**Goal:** Repair ZLI's shared runtime and provider integrations, complete ZLI naming, and verify the user workflows in a packaged Windows app.

**Architecture:** One managed-session service supplies launch/resume context, credential lifecycle, provider capabilities and event routing. Backend services own messaging and browser lifecycle; provider adapters translate supported provider interfaces. Frontend state is a projection, not a second delivery engine.

**Basis:** Static call-path audit of revision `fd9e9f3`, expanding `2026-09-12-zli-reliability-and-rename.md`. This supersedes its execution order. Carry forward its confirmed findings and rename/migration requirements. No production fixes or live provider tests were performed in this second audit. This is not a guarantee that every defect has been discovered.

## Provider coverage: current implementation, not vendor capability

| Provider | Launch integration | Runtime readiness for queued messages | Exact resume in ZLI | Required work |
|---|---|---|---|---|
| Claude Code | Bare launch; no Browser Use MCP registration | Narrow `❯` marker detector | Command builder exists; session ID discovery is fragile | Wire MCP, verified readiness/session capture, launch/resume environment |
| Codex | Launch plus stale external MCP compatibility override; no ZLI MCP registration | Narrow `›` marker detector | Command builder exists; session ID discovery is fragile | Wire ZLI MCP independently of compatibility override; verified lifecycle/session capture |
| Cursor Agent | Bare launch; accepts generic `agent` executable candidate | No detector | Explicitly unsupported | Verify executable identity; add provider config, readiness and supported resume integration |
| OpenCode | Bare launch | No detector | Explicitly unsupported | Implement and verify provider config, events, browser/tools and exact resume where supported |
| Gemini CLI | Generic adapter | No detector | Explicitly unsupported | Dedicated adapter with independently verified capabilities |
| Aider | Generic adapter | No detector | Explicitly unsupported | Verify shell/tool workflow; provide safe explicit fallback if native integration unavailable |
| Goose | Generic adapter | No detector | Explicitly unsupported | Dedicated adapter and verified tool/session integration |
| Z Code | No registered adapter found | None | None | Identify exact executable/product before defining support; add an adapter only against verified interfaces |

All registered providers currently share `mcp_provider_configured = false`. Giving a process environment variables is not MCP registration. “Unsupported” above describes ZLI code, not a claim that the vendor lacks the feature. Implementation must inspect current official provider documentation and installed CLI help/version; do not invent flags or install providers silently.

## Additional findings from the second trace

| ID / priority | Evidence and cause | Required repair / acceptance |
|---|---|---|
| A01 / P0 | `control/prompt_detector.rs` supports only Claude/Codex; `TeamCoordinator::handle_event` drains queues only on `AgentPromptDetected`. Other providers have no equivalent runtime readiness producer. | Provider-specific readiness or explicit inbox pull; every supported provider must receive queued messages without a fake prompt event. |
| A02 / P0 | `send()` enqueues but does not consult retained ready state. An already-idle agent may have emitted its only prompt before the message arrived. | Maintain readiness state and schedule on both enqueue and readiness transitions. Test sending after an agent has been idle for a minute. |
| A03 / P1 | Team spawn calls `backend.deliver(initial_task)` immediately after launch, independently of prompt readiness. | Queue initial task until authentication/onboarding is finished and provider is ready. Verify task is not typed into a consent dialog or dropped at startup. |
| A04 / P1 | Provider `parse_output()` implementations are referenced by fixtures/tests, but the inspected production output path uses `AgentOutputNormalizer` instead. | Connect provider lifecycle adapters to production events or remove misleading unused paths; test actual PTY-to-attention transitions. |
| A05 / P1 | Claude/Codex `resume_from_marker` takes the remainder of the first line containing `session id`. This can capture quoted content and does not prove a genuine conversation ID. | Capture authenticated/provider-owned session metadata, validate identifiers, and retain provenance; test exact conversation recovery, not just command construction. |
| A06 / P1 | `AppShell.tsx` silently returns for `browser-open-request` targeting an inactive project. | Route request to its project-owned surface or return an explicit actionable state; never leave caller polling until timeout. |
| A07 / P1 | Browser IPC allows a screenshot up to 10,000,000 characters, while `NamedPipeClient` allocates a fixed 1 MiB response. | Align transport/result budgets or return bounded artifact references/chunks. Test a screenshot whose encoded response exceeds 1 MiB. |
| A08 / P1 | Named pipe server has one instance and executes the handler inline; response `WriteFile` result/byte count is ignored. | Bounded concurrent clients, checked complete writes, explicit backpressure and shutdown deadlines. Slow browser wait must not block unrelated status or TaxChat calls. |
| A09 / P1 | Router checks timeout after handler completion; duplicate in-flight requests wait on a condition variable without their own deadline. | Propagate deadlines/cancellation; bound duplicate waits; distinguish timeout-before-action from unknown outcome after an action. Do not blindly retry clicks/messages. |
| A10 / P1 | Browser press dispatches synthetic keydown/keyup and returns success. This does not implement native Tab focus traversal, text editing or default Enter submission. | Define supported key semantics; use native input where required and verify the resulting state. Cover Tab, Enter, Escape, Backspace and modifiers. |
| A11 / P1 | All UI browser surfaces register with `agentId: null`; open requests carry project and URL only. | Document shared project browser ownership; serialize conflicting operations or introduce agent-owned surfaces with explicit sharing. Test simultaneous agent navigation and snapshot. |
| A12 / P1 | `taxChatRoom` is checkpointed, but `restoreSession` only forwards agents, panes and browser state; project switching resets the frontend TaxChat coordinator. | Restore project-scoped transcript, participants and backend queue bindings; switching/reopening must not lose conversation or route replies into another project. |
| A13 / P2 | Durable event log syncs every append and rewrites retained events whenever capacity is exceeded, including each later append. | Batch noncritical output persistence and rotate/compact with headroom. Measure disk writes and terminal latency under 12 active agents; preserve critical event durability. |
| A14 / P2 | Cursor accepts `agent` as a candidate without provider identity validation. Windows .cmd/.bat launch also needs real argument/quoting coverage. | Bounded provider identity/version probe; test executable paths with spaces, Unicode and session/config arguments. Never classify an unrelated executable as Cursor. |
| A15 / P1 | CLI `--json` prints failed responses but returns success; MCP tools use generic unrestricted object schemas and hardcoded protocol response. | Nonzero CLI exit on failed envelope; precise per-tool schemas; compatible MCP negotiation and correct notification handling. Verify with an actual MCP client. |

**Further bounded risks to reproduce, not proven runtime failures:** browser selectors miss iframes/shadow DOM and snapshots are depth-based rather than accessibility snapshots; click/fill do not prove interactability; snapshot construction allocates before result limiting; parallel calls can navigate a shared surface between selection and action; worktree deletion/restore and native overlay layout still need Windows stress testing. Capture reproductions before assigning defects to these paths.

## Implementation work packages

### 1. Repair shared session wiring first (P0)

**Files:** `src-tauri/src/lib.rs`, `commands.rs`, `control/{team,supervisor,security}.rs`; new `control/managed_agent_context.rs`.

- [ ] Register `Arc<TeamCoordinator>` in Tauri state; invoke real launch and stop commands to prove injection works.
- [ ] Centralize direct/child/retry/resume environment and event sink construction. Preserve provider environment and inject scoped credentials before process creation.
- [ ] Revoke on launch failure, stop and natural exit; renew long-running session credentials and replace old tokens safely. Validate executable existence.
- [ ] Acceptance: every installed provider launches from the UI and reports ZLI bridge availability; missing sidecars produce an explicit failure. Repeat with child and resume paths. Record unsupported paths honestly.

### 2. Establish provider contracts and readiness (P0; A01–A05, A14)

**Files:** `agents/providers/`, `control/prompt_detector.rs`, `pty/manager.rs`, `control/team.rs`; new provider capability report and fixtures per provider.

- [ ] Define capabilities independently: executable verified, MCP configured, shell tools available, readiness reliable, acknowledgement available, exact resume available. Do not equate installation with integration.
- [ ] Implement adapters for Claude, Codex, Cursor, OpenCode, Gemini, Aider and Goose against verified versions. Resolve Z Code identity before adding it.
- [ ] Connect real provider events to readiness state; queue initial tasks and deliver on enqueue when already ready. Fall back to explicit inbox polling/manual delivery where safe readiness cannot be determined.
- [ ] Capture actual session identities for supported providers; never infer completion/session identity from arbitrary output prose alone.
- [ ] Acceptance: send before ready, while busy and after idle; verify one submission and no interruption for each provider. Test onboarding/auth failure, redraws and process exit.

### 3. Integrate tools across providers (P0; A15)

**Files:** provider adapters, `bin/{zli,zli_browser_use}.rs`, `control/browser/gateway.rs`, shared tool contracts.

- [ ] Configure Browser Use and communication tools through each provider's supported session configuration; preserve existing user tools. Include configuration on resumed launches.
- [ ] Publish typed URL/surface/selector/text/key/timeout schemas and useful descriptions. Implement MCP negotiation/notifications and failure responses; failed CLI JSON commands exit nonzero.
- [ ] For providers without a verified native tool path, supply absolute CLI context and a tested shell fallback. If shell execution is unavailable, expose unsupported status instead of promising browser use.
- [ ] Acceptance per provider: ordinary request to open the fixture calls ZLI, obtains its visible surface, reads page content, and exchanges a message. Record tool-discovery failures separately from backend failures.

### 4. Fix browser and IPC together (P1; A06–A11)

**Files:** `control/transport/named_pipe.rs`, `control/router.rs`, `control/service.rs`, `control/browser/`, `BrowserPanel.tsx`, `AppShell.tsx`, browser store/bridge.

- [ ] Correlate open request IDs with surfaces and final redirected URLs; handle inactive projects, cancellation and closed panes explicitly.
- [ ] Configure real isolated WebView2 storage and transactional/versioned settings. Verify disable/revoke during active requests; clarify shared project surface ownership.
- [ ] Implement verified keyboard/action behavior and document iframe/shadow DOM limitations. Install instrumentation early enough to capture page-load errors.
- [ ] Align screenshot and transport sizes; verify checked response writes, bounded concurrency, deadline propagation and duplicate request behavior.
- [ ] Acceptance: redirect, background project, disabled permissions, large screenshot, simultaneous navigation, slow wait plus another agent's message, and packaged sidecar discovery all pass.

### 5. Unify TaxChat (P0/P1; A01–A03, A12)

**Files:** `control/team.rs`, new `control/taxchat.rs`, frontend coordinator/protocol/store, `sessionStore.ts`, `AppShell.tsx`.

- [ ] Use one durable backend queue for UI, CLI and MCP sends. Expose participant IDs, send, receive and acknowledgement operations.
- [ ] Remove direct PTY writes from the frontend delivery path. Distinguish queued/submitted/acknowledged/replied; never claim reading from a write result.
- [ ] Keep late replies deliverable after idle; implement explicit pause/stop and project-scoped restoration. Bound queues/history/parser buffers and suppress echoed/redrawn duplicate markers.
- [ ] Acceptance: all verified providers exchange messages with another provider, including a mixed-provider pair, after idle, while busy and after restart; pending status remains truthful when a provider cannot acknowledge.

### 6. Rename and migrate to ZLI (P1)

**Files:** Cargo/Tauri/npm metadata, executable imports, UI/asset labels, preference keys, worktree backend/frontend filters, current docs.

- [ ] Use `ZLI`, `zli-desktop.exe`, `zli_desktop_lib`, `zli.exe`, `zli-browser-use.exe`, and new `zli/` branches.
- [ ] Preserve existing app data through a versioned migration. Recognize verified legacy worktrees and keys; retain third-party compatibility names only where semantically required.
- [ ] Acceptance: existing sessions/projects survive upgrade; old worktrees remain reviewable/removable; newly created branches and packaged process display ZLI identity.

### 7. Remaining reliability and resource pass (P1/P2; A13)

**Files:** attention/session/workspace stores, event log/hub, PTY bridge, agent removal, native process/worktree code, terminal/layout components.

- [ ] Complete first-plan checks for attention accuracy, unread badges, exact resume, independent cleanup outcomes, file locks, 1–12 agent grids, native overlays, Git conflicts and project switching.
- [ ] Fix transactional listener setup and streaming Unicode decoding. Reduce event-log rewrite frequency; benchmark output latency, memory, listener count and child-process count.
- [ ] Check build cleanup against active processes before deletion; never remove live sidecars. Verify recovery after disk-full persistence errors and app crash using disposable fixtures.
- [ ] Acceptance: repeated launch/stop/switch cycles show no growing orphan-process/listener count; dirty work and locked files remain recoverable with precise cleanup status.

### 8. Release evidence, not source-string checks

- [ ] Build a controlled local website fixture: redirect, form, keyboard focus, console errors, large screenshot and slow load. Test through actual ZLI IPC/WebView2.
- [ ] Add a real desktop startup/invoke test plus per-provider smoke tests. Run focused regressions, full Rust/TypeScript checks and a packaged Windows smoke test.
- [ ] Write `docs/testing/zli-provider-feature-matrix.md`: provider/version, launch path, MCP discovery, shell fallback, browser actions, send/receive, readiness, resume, stop/revocation, actual result/evidence.
- [ ] Each cell is verified, partial, unsupported or not tested. Absent providers remain untested, not passing. Update README claims to match this matrix.

## Completion gate

The first milestone is a reliable shared runtime; the second is working browser and messaging integrations for every installed registered provider, with explicit fallback/unsupported results for unavailable capabilities. Release additionally requires upgrade-safe ZLI naming and the remaining workflow tests. Review and commit each verified repair separately. Add newly reproduced defects to the ledger; do not close the project on the strength of compilation, mocks or one successful Claude run.
