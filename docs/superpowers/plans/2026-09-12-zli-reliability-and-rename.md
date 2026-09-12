# ZLI Rename and Reliability Implementation Plan

**Goal:** Make ZLI consistently named and make its advertised workflows work in the actual Windows app.

**Architecture:** Share one managed-agent launch context across UI launches, team children, and resume. Rust owns credentials, message queues, browser lifecycle, and persistence; the frontend displays their state. Provider adapters declare and verify supported integrations.

**Tech stack:** Tauri, Rust, WebView2, React, TypeScript, provider CLIs, local authenticated IPC.

**Scope:** User-requested rename and repository reliability audit, based on local revision `fd9e9f3`. This document is a static code audit and implementation plan, not evidence that runtime features work. No production code was changed for this audit. Existing specs are intended behavior, not proof of implementation.

## Confirmed findings

| Priority | Issue and cause | Fix location / approach |
|---|---|---|
| P0 | `launch_agent` and `stop_agent` require `State<Arc<TeamCoordinator>>`, but startup never manages that state. The previous launcher fix compiles but leaves a runtime command dependency unsatisfied. | `src-tauri/src/lib.rs`, `commands.rs`: register the shared coordinator and exercise actual Tauri commands. |
| P0 | Ordinary launch and resume sinks use `observer: None`. TeamCoordinator receives prompt/exit events through a different observer-equipped sink. Direct-agent queued delivery and exit token revocation therefore lack the same event path. | `commands.rs`, `control/team.rs`: use one observer-equipped runtime sink for every agent lifecycle. |
| P0 | Resume uses `spawn_agent_with_size_args`, ignoring the provider plan's environment and managed browser credentials. | `control/supervisor.rs`: merge provider and fresh scoped environment during resume; retain exact conversation identity. |
| P0 | MCP provider configuration is literally `false`; producing an adapter binary does not register tools with Claude or other providers. Shell availability is reported from an optional path without checking that the executable exists. | `control/team.rs`, `agents/providers/`, `bin/zli_browser_use.rs`: verified launch integration, useful tool schemas, actual binary checks. |
| P0 | TaxChat has two delivery routes. `AppShell.tsx` writes directly to ordinary terminals, but queues team agents. `taxChatCoordinator.ts` marks a successful write/queue submission delivered without provider acceptance. | Unify both behind backend queued delivery; display queued, submitted, acknowledged, failed separately. |
| P1 | TaxChat depends on printed markers, parses terminal output, and discards output when room status is not running. A 45-second timer sets idle; `start()` does not introduce agents or tools. | Backend room/inbox lifecycle, explicit participants and tools; distinguish idle display from paused delivery. |
| P1 | Browser open completion polls exact URL equality. Redirects or URL normalization can prevent the requested URL matching the registered final surface. | `control/service.rs`, `browser/executor.rs`, browser UI: correlate open request IDs with surface creation; track final URL separately. |
| P1 | Browser creation passes no explicit storage directory/profile option; `profileId: clean` is registered afterward. This does not establish the promised profile-storage boundary. | `BrowserPanel.tsx` and native browser creation: explicitly configure and verify WebView2 storage ownership. |
| P1 | Browser settings mutate memory before persistence succeeds. Windows fallback removes the old settings file before replacement; schema version is not validated. | `control/browser/settings.rs`: validate version, persist replacement safely, then publish memory state. |
| P1 | Agent and local discovery credentials expire after 12 hours, with no renewal shown in the inspected lifecycle. | `control/security.rs`, `team.rs`, CLI discovery: refresh authenticated sessions without writing secrets to transcripts/checkpoints. |
| P1 | Rename is incomplete: Cargo binary/library are swarmterm, UI is Taxzy, npm package is tauri-app, and newly created branches still use `swarm/`. | Cargo, Tauri, frontend branding, worktree creation/audit/filtering, storage migrations, docs. |
| P1 | Resource removal has sequential failure exits; failures can retain records or prevent later cleanup. Existing tests cover selected cases, not a complete Windows locked-worktree workflow. | `src/lib/agentRemoval.ts`, agent/session stores, native worktree/process cleanup: report independent resource outcomes and permit safe retries. |
| P2 | PTY bridge sets up multiple listeners but does not unwind listeners already attached if setup fails. Its byte-output fanout constructs a fresh TextDecoder per chunk. | `src/terminal/ptyBridge.ts`: transactional subscription cleanup and per-terminal streaming decoding. |
| P2 | Resume support is explicitly unsupported for Cursor, OpenCode, and generic adapters. Tests include source-string checks, which cannot prove app wiring. | Accurate feature matrix and real desktop/provider acceptance tests. |

The missing Claude GSD hook paths reported by the user are external configuration errors. They are not proof of a ZLI browser failure. Diagnose the referenced files/config separately; do not silently rewrite global Claude settings.

## Ordered implementation

### 1. Repair agent startup, stop, resume, and event routing

**Files:** `src-tauri/src/lib.rs`, `commands.rs`, `control/team.rs`, `control/supervisor.rs`, `control/security.rs`; introduce `control/managed_agent_context.rs` for shared scoped launch preparation and credential lifetime.

- [ ] Reproduce Add Agent and Stop through the real app, recording the actual command error. Register the shared coordinator as Tauri state.
- [ ] Use one launch-context builder and one event observer path for direct, child, retry, and resumed agents. Merge provider environment with scoped credentials before spawning.
- [ ] Revoke credentials on failed startup, stop, and natural exit; revoke superseded tokens on replacement. Provide renewal for long sessions.
- [ ] Check bundled executable existence before advertising tools. Report missing sidecars in the UI.
- [ ] Acceptance: create Claude from the sidebar, call browser status from its shell, stop it, verify token rejection; repeat with a child and resumed conversation. Also test early exit and failed registration.

### 2. Complete ZLI naming with migration

**Files:** `src-tauri/Cargo.toml`, `Cargo.lock`, `tauri.conf.json`, `src/main.rs`, both CLI binaries, `package.json`, `package-lock.json`, `index.html`, `src/components/`, preference/workspace/browser stores, `src-tauri/src/git/worktree.rs`, `src/lib/worktreePresentation.ts`, `WorktreeDialog.tsx`, README and current handoff docs.

- [ ] Set product/window/UI name to **ZLI**, desktop executable/package to `zli-desktop`, Rust library to `zli_desktop_lib`, npm package to `zli`; retain `zli.exe` and `zli-browser-use.exe` as separate commands.
- [ ] Change newly generated branches to `zli/`; recognize verified legacy `swarm/` worktrees for audit/removal. Update backend and frontend filters together.
- [ ] Introduce versioned migration for `taxzy:*` preference keys and app-data discovery. Keep existing `com.taxzy.cli` storage identity until migration preserves sessions, URLs, grants, and CLI discovery. Do not rename working checkout directories behind active processes.
- [ ] Remove stale branding in live copy, errors, assets, and current docs. Keep necessary third-party names in compatibility handling and historical attribution; those are not ZLI branding.
- [ ] Acceptance: packaged process is `zli-desktop.exe`; new branch is `zli/...`; existing projects, sessions, and old worktrees remain accessible after upgrade. Report any legacy strings that remain intentionally.

### 3. Make providers discover browser and communication tools

**Files:** `agents/providers/{mod,claude_code,codex,cursor,opencode}.rs`, `control/team.rs`, `bin/zli_browser_use.rs`, `control/browser/gateway.rs`; introduce shared tool-contract definitions used by MCP and CLI help.

- [ ] Verify installed providers' supported launch/configuration interfaces against their current documentation and local help before implementing adapters.
- [ ] Configure the local MCP server for Claude sessions, including resume, using session-scoped settings. Preserve existing user MCP servers. Add Codex next; declare other providers unsupported until tested.
- [ ] Provide concrete tool descriptions and parameter schemas (URL, surface ID, selector, text, key, timeouts), not unrestricted empty schemas. Handle initialization/notifications/errors consistently.
- [ ] Give shell-only providers brief startup context with the absolute command path, browser commands, participant listing, and messaging commands. A prompt alone is not tool installation.
- [ ] Acceptance: a new Claude agent asked normally to open a test website discovers ZLI tools, opens the visible pane, and returns its DOM content. Record provider version, tool calls, and failures; never claim every CLI works from one provider test.

### 4. Make browser operations reliable

**Files:** `control/browser/{mod,executor,settings}.rs`, `control/service.rs`, `BrowserPanel.tsx`, `src/lib/browser/`, `browserStore.ts`.

- [ ] Replace URL-based open polling with request-ID-to-surface completion and bounded cancellation. Handle redirects, duplicate requests, inactive projects, pane closure, and startup failure explicitly.
- [ ] Configure the actual WebView2 storage directory and document its scope: one isolated ZLI profile, with project-scoped authorization. Do not imply per-agent cookie isolation unless implemented.
- [ ] Reinstall instrumentation on navigation so early console/page errors are captured. Verify click, fill, key input, snapshot, screenshot, and error reporting on a controlled local fixture.
- [ ] Make settings writes transactional and schema-aware. Validate revocation/master-disable at execution time, including queued commands.
- [ ] Acceptance: redirecting URL opens successfully; tools act on the same visible pane; navigation and reopening work; disabled control denies actions; another project cannot control the surface; profile data stays separate from external browsers.

### 5. Make TaxChat an actual communication channel

**Files:** `src/lib/taxChatCoordinator.ts`, `taxChatProtocol.ts`, `src/stores/taxChatStore.ts`, `teamStore.ts`, `AppShell.tsx`, `TaxChatPanel.tsx`, `control/team.rs`, `control/service.rs`; introduce `control/taxchat.rs` for backend room policy and routing.

- [ ] Route all sends through the durable backend inbox. Remove direct frontend PTY writes as a delivery mechanism.
- [ ] Expose participant discovery, send, and inbox/acknowledgement through authenticated CLI/MCP. Identify real agent IDs; introduce the room to participants when enabled.
- [ ] Deliver terminal prompts only when a provider is ready. Do not call a PTY write proof of reading or reply; track submission and acknowledgement separately. Present unsupported provider acknowledgement honestly.
- [ ] Retain incoming messages during idle, enforce explicit pause/stop, bound message size/history/queue depth, and use message IDs plus reply references to prevent repeats and loops.
- [ ] Keep markers only as a bounded compatibility fallback. Handle fragmented ANSI/UTF-8, echoed instructions, redraw duplicates, malformed/unclosed markers, and late replies.
- [ ] Acceptance: agent A asks B a question, B receives it and replies, A receives the reply, and the user sees both. Repeat after 60 seconds of silence, while B is busy, across pause/resume, and after restart. No fabricated delivered state or unsolicited interruption.

### 6. Audit remaining advertised workflows in the real app

**Files:** attention/provider adapters, session and workspace stores, `agentRemoval.ts`, native process/worktree code, terminal bridge/layout, and relevant dialogs.

- [ ] Attention: verify Working / Waiting for you / Completed / Failed against actual provider events. Process alive does not establish working; an idle prompt does not prove successful completion. Check unread acknowledgement and duplicate notifications.
- [ ] Resume: verify exact Claude/Codex conversation, scrollback, project, grid, and browser URL. Show unsupported providers explicitly. Verify resumed agents are reflected consistently in runtime and UI registries.
- [ ] Removal: independently track process termination, pane/session removal, and worktree cleanup; locked worktrees remain retryable while processes are stopped. Test offline agents, missing paths, dirty worktrees, and file locks without deleting user work.
- [ ] Terminal/layout: fix partial-listener cleanup and streaming decode; exercise 1–12 agents in two columns, resizing, sidebar collapse, browser/TaxChat open together, project switching, and no black bottom strip.
- [ ] Git: test commit, merge success/conflict/abort, discard confirmation, and cleanup against temporary repositories. Verify cleanup recognizes old and new managed branches without broadening deletion scope.
- [ ] Resource/storage: measure child-process count, memory and listeners after repeated launch/stop/switch cycles. Remove only confirmed unused build artifacts; never delete running app sidecars as happened in the earlier cleanup.

### 7. Replace completion claims with acceptance evidence

**Files:** `tests/`, native integration tests, `README.md`, `docs/HANDOFF_CODEX.md`; create `docs/testing/zli-feature-matrix.md` and a controlled browser fixture.

- [ ] Add desktop startup/invoke integration coverage that fails on missing Tauri state. Retain useful unit tests; do not use source-string assertions as feature acceptance.
- [ ] Run focused regression tests per change, then full Rust/TypeScript tests and production build once integrated. Exercise a packaged Windows app to verify sidecar paths and fresh-install discovery.
- [ ] Record each feature as **verified**, **partial**, **unsupported**, or **not tested**, with app/provider versions, steps, expected/actual results, and evidence. Include every workflow in Task 6, browser, TaxChat, and rename migration.
- [ ] Update product documentation to match the matrix. A feature becomes verified only after the real workflow succeeds; passing mocks or compilation alone is insufficient.

## Execution and completion rule

Implement Tasks 1–7 in order, with a reviewable commit for each independently verified repair. Run each task's acceptance checks before marking its boxes complete. The broader workflow audit may uncover additional defects; add their reproduction and cause to this plan before claiming coverage. Do not reinstall tools, alter global provider hooks, delete worktrees, or publish a release merely to make a test pass.

The release gate is a fresh sidebar-launched Claude using ZLI's visible browser, two agents exchanging acknowledged messages, successful supported-session resume, safe removal, preserved upgrade data, and consistent ZLI branding in the packaged app. Anything not exercised stays explicitly unverified.
