# ZLI Mobile for AI-agent app development: build spec (Phase 3)

Branch `feat/mobile-ai-dev` (HEAD `2ea5359`, v0.1.14). Inputs: `docs/mobile-audit.md` (what exists, extension points) and `docs/mobile-research.md` (Part 1 pains P1-P11, Part 2 wrap vs build). Paths are relative to `v2/` unless they start with `docs/` or `/`.

This spec is written for build agents that each work in their own git worktree off `feat/mobile-ai-dev`. Read "Parallel build plan" first: one small scaffold stream (S0) lands before the three feature streams start, so the feature streams never edit the same lines.

## 1. What ships in this PR

| # | Feature | Pains it addresses | Stream |
|---|---|---|---|
| F0 | Proposals: one confirm-before-run card for every command or file write a feature generates | Safety rule 2; P3, P4 (fix commands) | S0 |
| F1 | Per-worktree Metro port and device isolation | P2 (rank 2, "the core ZLI use case") | S1 |
| F2 | Mobile doctor: toolchain fingerprint, known-bad combos, Expo Go vs dev build, signing state, `zli:mobile` block in AGENTS.md | P3, P8, P9, P11 | S2 |
| F3 | Package guard via React Native Directory before install | P3, P9 | S2 |
| F4 | Live device log with crash detection and a crash card | P6 | S3 |
| F5 | Build-failure classifier and agent brief (version checks first) | P4, P5, P3 | S3 |

### Later (not in this PR)

- **(a) Wrap agent-device as the agent device runtime.** Deferred, first in line for the next PR. Every ZLI agent already gets the screenshot plus UI-tree loop through `zli-mobile` (`mobile_snapshot`, `mobile_screenshot`, `mobile_tap`). On Linux, agent-device drives Android only, which `zli-mobile` already covers. Wrapping it safely needs a stdio proxy that obeys the person's "Let agents use devices" switch and passes per-worktree `AGENT_DEVICE_SESSION` and device allowlists. Those come from F1's allocator, and none of it can be verified on this machine (no agent-device, no device). Plan: `zli-mobile agent-device-mcp` subcommand that checks `mobileaccess`, then execs a pinned `agent-device mcp` with `AGENT_DEVICE_SESSION=zli-<worktreeId>` and `AGENT_DEVICE_ANDROID_DEVICE_ALLOWLIST=<leased serial>`, or serves an empty tool list.
- Per-worktree iOS simulators (`simctl clone`), per-worktree DerivedData, RAM-sized build slot pool, orphan `xcodebuild`/Gradle sweeps (P2, macOS).
- Fetching EAS logs (`eas build:list/view --json`) for F5. In this PR F5 takes pasted text or a log file.
- Diff guards: escape-hatch scan (P5), permission and config-plugin linter (P7), design-token lint (P10).
- OTA safety: runtime/fingerprint check before `eas update` (P8 release side).
- Optional third-party MCP servers in Settings (mobile-mcp, Argent, Maestro, Expo MCP, MobileBuildMCP) (P11).
- `ANDROID_SERIAL` injection, a `mobile` block in `zli.json`.

## 2. Hard safety rules, and how this spec meets them

1. **The runtime token never reaches a child process.**
   - Commands the person approves run in a visible ZLI terminal through `terminal.create`. They go through the daemon and `childPtyEnv` (`apps/server/src/terminal/NodePtyFactory.ts:72-84`), which already deletes `ZLI_RUNTIME_TOKEN`, `ZLI_DAEMON_TOKEN`, and `ZLI_DAEMON_ENDPOINT_PATH`.
   - Read-only probes and deep checks run in the desktop main process through `ProcessRunner`. The desktop never holds the token (audit section 2). As defense in depth, S0 adds `mobileChildEnv()` and every new probe uses it. S0 also changes `main.ts:364` to `env: mobileChildEnv(process.env)`.
   - The only new variables for agent PTYs are `ZLI_METRO_PORT` and `RCT_METRO_PORT` (F1). Both are added to `ENV_OVERRIDE_RULES` (`apps/server/src/daemon-entry.ts:215`) with a strict port validator. There are no new secrets and no new token variables.
2. **Nothing a feature generates runs without the person's explicit confirmation in the UI.**
   - Installs, fixes, builds, `npx expo install`, and the AGENTS.md block all become **Proposals** (F0). The person sees the exact command (or the exact file change) and its working folder, then clicks Run in terminal or Write. The IPC call takes only a proposal id, so the renderer cannot change what runs.
   - Agents can create proposals with `mobile_propose`, and tool results present commands as suggestions. **No zli-mobile tool ever executes a generated command.** (ZLI cannot stop an agent from typing a command in its own shell; that stays governed by the agent's permission mode. Tool text tells agents to propose rather than run.)
   - Read-only probes run without confirmation: file reads, `node -v`, `java -version`, `adb version`, `adb devices -l`, `emulator -list-avds`, `xcodebuild -version`, `pod --version`, `xcrun simctl list --json`, `security find-identity -v -p codesigning`, `lsof`/`ss`/`/proc` port checks, and `adb logcat` streaming.
   - Checks that execute project or npm code (`npx expo config`, `npx expo install --check`, `npx expo-doctor`) are **not** treated as read-only. They run only when the person clicks Run Expo checks, after the button's panel lists the exact commands.

## 3. Conventions for every stream

- Follow `DESIGN.md`. Use primitives from `apps/web/src/ui/*` (Button, IconButton, Switch, Badge, Field, PaneHeader, EmptyState, LoadingState) and tokens from `packages/ui/src/tokens.css`. Feature CSS goes in a stylesheet next to the feature's components that only that stream owns: `apps/web/src/mobile/dev/dev.css` (S0), `dev/workspace/workspace.css` (S1), `dev/doctor/doctor.css` (S2, shared by doctor and packages), `dev/crash/crash.css` (S3, shared by crash and build). S0 creates all four, empty, and imports them once. Green, amber, and red mean state only. The accent is for the one primary action.
- Copy is plain sentences about what happened and what the person can do. Name the person "you" in UI and "the person" in agent-facing text.
- `/AGENTS.md` asks for the antislop skill on UI and copy work. It is not installed here; the orchestrator decides how to handle it.
- Every IPC payload is zod-parsed in main (`mobileIpc.ts` pattern). Every preload result is zod-parsed.
- Every external process goes through `ProcessRunner` (testable with `FakeProcessRunner`). Every file read goes through `MobileFileSystem` (`apps/desktop/src/mobile/host.ts`). Every HTTP call goes through `FetchLike` (`apps/desktop/src/mobile/download.ts`).
- Every probe has a timeout (5 s for version probes, 60 s for deep checks) and may be missing. A missing tool is reported as "Not found", never as an error.
- New agent actions are lowercase letters only (they become HTTP routes). The agent-tools gate (`MobileControlActions.ts:145-147`) applies to every new action automatically.
- Validation before handing back: `npm run verify` from the repo root (about 3 min). If Mobile UI changed: `npm run build`, then `cd v2 && ZLI_RUN_E2E=1 xvfb-run -a pnpm exec playwright test tests/e2e/mobile*.spec.ts`. This needs pnpm 10.34.9 through corepack (audit section 7).
- Do not commit or push unless the orchestrator says so.

---

## 4. F0: Proposals, scaffold, and the e2e fake (stream S0)

### Problem

Safety rule 2 applies to F1, F2, F3, and F5, and each one generates commands or file writes (`npx expo install --fix`, `npx expo install <pkg>`, `cd ios && pod install`, the AGENTS.md block). One shared confirm-and-run path keeps the rule in one place. The audit also notes there is no way to inject a fake device into the packaged app for e2e (audit section 4.G, section 5).

### Scope

In: the proposal model, store, IPC, the card UI in the Mobile panel, running a command in a visible terminal, writing a marked block to AGENTS.md or CLAUDE.md, the `mobile_propose` agent tool, every extension slot listed in section 10, `mobileChildEnv`, and the e2e fake mobile service.

Out: any feature logic.

### Contracts: `packages/contracts/src/mobileDev.ts` (new)

```ts
export const SAFE_ARG = /^[A-Za-z0-9@._\/:=+,%^~-]{1,300}$/u;
export const PROPOSAL_PROGRAMS = ["npx", "npm", "pnpm", "yarn", "bun", "expo", "eas", "./gradlew", "gradlew.bat", "pod", "bundle", "flutter", "adb", "xcrun"] as const;

export const MobileProposalAction = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("command"),
    program: z.enum(PROPOSAL_PROGRAMS),
    args: z.array(z.string().regex(SAFE_ARG)).max(32),
    /** Relative to the worktree root, no "..". */
    cwd: z.string().max(300).default("."),
    /** Extra env for this command only, e.g. CI=1. Keys from a fixed list. */
    env: z.record(z.enum(["CI", "EXPO_NO_TELEMETRY"]), z.enum(["1"])).optional(),
  }),
  z.object({
    kind: z.literal("file-block"),
    file: z.enum(["AGENTS.md", "CLAUDE.md"]),
    marker: z.literal("zli:mobile"),
    /** The new text between the markers. */
    content: z.string().max(8_000),
    /** sha256 of the whole file when the proposal was made, or "absent". Writing refuses if it changed. */
    baseDigest: z.string().max(80),
  }),
]);
export const MobileProposal = z.object({
  proposalId: z.string().uuid(),
  worktreeId: z.string(),
  source: z.enum(["zli", "agent"]),
  sourceLabel: z.string().max(120),   // "Project check" or "The agent in feat-login"
  title: z.string().min(1).max(120),
  reason: z.string().max(600),
  action: MobileProposalAction,
  state: z.enum(["pending", "started", "written", "dismissed", "failed"]),
  error: z.string().max(500).optional(),
  terminalId: z.string().optional(),
  createdAt: z.string().datetime(),
});
export const MobileProposalIdInput = z.object({ proposalId: z.string().uuid() });
export const MobileControlProposeInput = MobileControlDeviceInput.extend({
  title: z.string().min(1).max(120), reason: z.string().max(600),
  program: z.enum(PROPOSAL_PROGRAMS), args: z.array(z.string().regex(SAFE_ARG)).max(32), cwd: z.string().max(300).optional(),
});
// Cross-stream types, defined here so S1, S2, and S3 can code against them in parallel.
// Streams may only add optional fields to these.
export const MobileFinding = z.object({
  id: z.string().max(80), severity: z.enum(["error", "warning", "info"]),
  title: z.string().max(200), detail: z.string().max(1_000),
  fix: MobileProposalAction.optional(), source: z.string().url().optional(),
});
export const MobileProjectFactsCore = z.object({
  worktreeId: z.string(), appDir: z.string(), // relative to the worktree, "." for root
  stack: z.enum(["expo", "react-native", "flutter", "android", "ios", "none"]),
  versions: z.record(z.string().max(60), z.string().max(60)), // { expo: "56.0.3", "react-native": "0.85.1", java: "17.0.12", ... }
  findings: z.array(MobileFinding).max(50),
  fingerprint: z.string().max(40),
  checkedAt: z.string().datetime(),
});
```

`mobile.ts` (S0 edits once):
- Add to `MOBILE_CONTROL_ACTIONS`: `mobilepropose`, `mobileworkspace`, `mobiledoctor`, `mobilecheckpackage`, `mobilecrashes`, `mobilebuildbrief`.
- Extend `MobileSettings` with `crashWatch: z.boolean()` and set `DEFAULT_MOBILE_SETTINGS.crashWatch = true`. `MobileSettingsStore` must default missing fields when it reads an older file.
- `index.ts`: export `./mobileDev.js`, `./mobileWorkspace.js`, `./mobileDoctor.js`, `./mobilePackages.js`, `./mobileLogs.js`. S0 creates the last four files with a one-line comment and `export {};`, and each stream owns its own file.

### Desktop

- `apps/desktop/src/mobile/dev/childEnv.ts`: `mobileChildEnv(env)` returns a copy without `ZLI_RUNTIME_TOKEN`, `ZLI_DAEMON_TOKEN`, `ZLI_DAEMON_ENDPOINT_PATH`, or `ZLI_BROWSER_CONTROL_FILE`.
- `apps/desktop/src/mobile/dev/ProposalStore.ts`:
  - Keeps proposals in memory, at most 20 per worktree, and at most 5 pending agent proposals per worktree (the next one gets 429).
  - `create`, `list(worktreeId?)`, `dismiss(id)`, and `accept(id)`.
  - For `command`, `accept` resolves the worktree path from `runtime.projection().worktrees` and refuses a `cwd` outside it. It builds the shell line with each argument single-quoted (`/bin/bash -lc` on macOS and Linux, `cmd.exe /d /s /c` on Windows, as `WorktreeSetup.ts:41-44` does). Env such as `CI=1` is set as a `KEY=1 ` prefix on POSIX and `set KEY=1&&` on Windows. It then sends `terminal.create` through `runtimeCommand` (the same way `main.ts:344` reaches the runtime) with title `<title>`, and records `terminalId`.
  - For `file-block`, `accept` re-reads the file and refuses with "AGENTS.md changed after ZLI showed this change. Check again to see the new version." when the sha256 differs from `baseDigest`. Otherwise it replaces the text between `<!-- zli:mobile:start -->` and `<!-- zli:mobile:end -->`, or appends the block with one blank line before it, or creates the file. It writes atomically (temp file plus rename).
  - It emits `zli:mobile:proposals` with the full list on every change.
- `apps/desktop/src/mobile/dev/host.ts`: the `MobileDevHost` type every feature receives: `{ runner, fs, fetch, os, env (already scrubbed), home, worktrees(), worktreePath(id), manager(), settings(), proposals, send(channel, payload), now() }`.
- `apps/desktop/src/mobile/dev/index.ts`: `createMobileDev(host)` returns `{ actions, decorate, ipc, dispose }`, composed from per-feature stubs, which S0 creates and the streams fill in:
  - `dev/workspace/index.ts` (S1), `dev/doctor/index.ts` (S2), `dev/packages/index.ts` (S2), `dev/crash/index.ts` (S3), `dev/build/index.ts` (S3).
  - Each stub exports `create<Feature>(host): MobileDevFeature`, which by default returns `{ actions: {}, ipc: {}, decorate: undefined, testOps: {}, dispose() {} }`.
  - `dev/doctor/facts.ts` (S2-owned stub): `projectFacts(host, worktreeId): Promise<MobileProjectFactsCore | undefined>` returns `undefined` until S2 fills it. S3 imports it.
- `MobileControlActions.ts` (S0 edits once):
  - Add optional `dev?: { actions: Partial<Record<MobileControlAction, DevAction>>; decorate?(owner, action, result): unknown }` to `MobileControlHost`.
  - In `run` after the gate: `const extension = host.dev?.actions[action]; if (extension) return extension(input, context)`, where `context = { ownerFor, online, pickDevice, lease }`.
  - Wrap the switch's return as `host.dev?.decorate ? host.dev.decorate(ownerFor(input), action, result) : result`.
  - Implement `mobilepropose` in `dev/proposalActions.ts`.
- `mobileIpc.ts` (S0 edits once): add `dev?(): MobileDevIpc | undefined` to deps, and end the returned object with `...devIpcHandlers(deps.dev)`. Handler channels are `zli:mobile:<feature>:<verb>`. S0's own channels are `zli:mobile:proposals:list`, `zli:mobile:proposals:accept`, `zli:mobile:proposals:dismiss`, and the event `zli:mobile:proposals`.
- `main.ts` (S0 edits once):
  - Build the dev host and `createMobileDev` next to `createMobileControlActions` (`main.ts:376`), and pass it into both and into `registerMobileIpc`.
  - Use `mobileChildEnv(process.env)` at line 364. Call `dispose` at shutdown (845-849).
  - Add the **e2e hook**: when `process.env.ZLI_TEST_PROVIDER === "mock" && process.env.ZLI_TEST_MOBILE === "fake"`, use `createFakeMobileService()` instead of `createMobileService()`, and register `ipcMain.handle("zli:test:mobile", …)`, which dispatches `{ op, input }` to the composed `testOps` and rejects outside mock mode, like `zli:test:take-open-in` (`main.ts:687`).
- `apps/desktop/src/mobile/testing/fakeMobileService.ts` (new):
  - Returns the same shape as `createMobileService`: a `DeviceManager` over `FakeDriver("android")` with one AVD `Pixel_Test`, running as `emulator-5554`, and `FakeDriver("ios")`.
  - `status()` reports Android ready (all probes found) and iOS unsupported. The setup and AVD functions are no-ops.
  - In fake mode the dev host gets a `FakeProcessRunner` and a fake `fetch`, so feature code never runs real tools or reaches the network. The test ops `runner-answer` `{ match, answer }` and `fetch-answer` `{ url, status, json }` script their answers.
- `mobile-tool/mcp.ts` (S0 edits once):
  - `MOBILE_MCP_TOOLS = [...CORE_TOOLS, ...MOBILE_DEV_MCP_TOOLS]`, from `mobile-tool/devTools.ts`, which concatenates the per-feature stubs `mobile-tool/dev/{propose,workspace,doctor,packages,crash,build}.ts`. Each exports `tools: McpTool[]`, `format?(action, result): ToolResult | undefined`, and `instructions: string`.
  - `formatMobileResult` tries the dev formatters first.
  - The server `instructions` (line 230) ends with the joined dev instruction strings.
  - S0 fills `propose.ts`:

    ```
    name: "mobile_propose", title: "Propose a command",
    description: "Ask the person to run a command, such as an install or a fix, in this worktree. ZLI shows it in the Mobile panel with Run in terminal and Dismiss; nothing runs until they choose Run. Use this instead of running installs or fixes yourself."
    ```

- `mobile-tool/cli.ts` (S0 edits once): a generic path, so `zli-mobile <tool_name> --json '<args>'` runs any tool in `MOBILE_DEV_MCP_TOOLS`. No per-feature CLI edits are needed.
- `preloadApi.ts` (S0 edits once): `createMobileApi` gains `dev: createMobileDevApi(ipc)` from `apps/desktop/src/mobileDevApi.ts`, which composes the per-feature stubs `apps/desktop/src/mobile/dev/<feature>/preload.ts`. These import only `@zli-v2/contracts`, because the preload bundle must not pull in Node code.

### Web

- `runtime/bridge.ts` (S0 edits once): `MobileBridge` gains `dev?: MobileDevBridge` from `apps/web/src/mobile/dev/bridge.ts`. That type is `{ proposals: ProposalsBridge } & WorkspaceBridge & DoctorBridge & PackagesBridge & CrashBridge & BuildBridge`, and each type lives in `apps/web/src/mobile/dev/<feature>/bridge.ts` (stub `export type XBridge = { x?: never }`).
- `shell/AppShell.tsx` (S0): pass `worktreeId={…current worktree…}` to `<MobilePane>` (line 2216), using the same worktree whose dev servers feed `mobileDevServers`.
- `mobile/MobilePane.tsx` (S0 edits once):
  - New prop `worktreeId?: string`. Build `const devContext: MobileDevContext = { mobile, worktreeId, device, online, agentHolds, devServers, onError: setActionError, onNotice: showNotice }`.
  - Render `<MobileDevBanners context={devContext} />` right after the `ExpoBanner` block (line 573).
  - Add a PaneHeader `IconButton` with icon `shieldCheck`, label "Project check", tooltip "Check this project's mobile setup", `pressed` while open. It sets `setupFor("project")`, and the body renders `<MobileProjectView context={devContext} />`.
- `mobile/dev/MobileDevBanners.tsx` (S0): renders `<ProposalCards/>` (S0), `<WorkspaceBanner/>` (S1 stub), and `<CrashBanner/>` (S3 stub), in that order.
- `mobile/dev/MobileProjectView.tsx` (S0): a scrolling column of titled groups, with the same look as the setup view: `<WorkspaceProjectGroup/>` (S1), `<DoctorGroup/>` (S2), `<PackagesGroup/>` (S2), `<BuildGroup/>` (S3). Every stub returns `null`. With no `worktreeId` it shows `EmptyState` with icon `smartphone`, title "Open an agent or worktree first", and detail "The project check looks at the folder the current agent works in."
- `settings/MobileSection.tsx` (S0 edits once): render `<MobileDevSettingGroups mobile={mobile} />` between the Agents group (ends line 179) and Android SDK. It composes `<WorktreesSettingGroup/>` (S1) and `<CrashWatchSettingGroup/>` (S3).
- `settings/SettingsDialog.tsx:105` (S0): add the keywords "metro port worktree doctor expo crash build package".
- `mobile/dev/sendToAgent.ts` (S0): `sendToWorktreeAgent(runtime, worktreeId, text)` picks the most recently active chat thread in the worktree whose status accepts input, then sends `thread.send` (the same command `AppShell.tsx:729` sends). It returns `false` when there is no chat agent. F4 and F5 use it.
- `mobile/dev/ProposalCards.tsx` (S0): one card per pending or started proposal for this worktree, on the raised surface.
  - The first line is `sourceLabel` in dim text, for example "Proposed by the agent in feat-login". Then the title in body text, then the reason.
  - For a command, the exact line goes in a mono well, followed by "Runs in <cwd> in a new terminal."
  - For a file block, show "Adds these lines to AGENTS.md:" with the block in a mono well, collapsed to 6 lines with a "Show all" toggle.
  - Buttons: the primary is **Run in terminal** or **Write to AGENTS.md**, plus **Dismiss**. While the request is in flight the button shows its loading state. A started command shows "Running in the terminal drawer" with an **Open terminal** button. A failure shows the error inline under the card.

### Tests

- Unit:
  - `ProposalStore.test.ts`: argument quoting on POSIX and Windows. Refusal of `cwd` with `..` or an absolute path, and of programs outside the list. Agent rate limit. The `terminal.create` payload, asserting no `envOverrides` (rule 1). The file-block cases: create, replace between markers, append, a changed digest refused, CRLF files kept CRLF.
  - `childEnv.test.ts`: strips the four keys.
  - `mobileIpc.test.ts`: the proposal channels and zod rejection.
  - `MobileControlActions.test.ts`: `mobilepropose` goes through the gate, and the 403 when agent tools are off.
  - `zli-mobile.test.ts`: the tool list includes `mobile_propose`, and the generic CLI path works.
  - `preload.test.ts`: the dev API parses results.
  - `ProposalCards.test.tsx`: copy, Run sends only the id, Dismiss.
  - `MobileSettingsStore.test.ts`: an old file without `crashWatch` reads as `true`.
- e2e: `tests/e2e/mobile.spec.ts`. Launch with `env: { ZLI_TEST_MOBILE: "fake" }`, open Mobile (Mod+Shift+M), and see `Pixel_Test` running. Call `zli:test:mobile` `{ op: "propose", input: { program: "npm", args: ["--version"] } }`, see the card, click Run in terminal, and see a terminal titled with the proposal title in the drawer.

---

## 5. F1: Per-worktree Metro port and device isolation (stream S1)

### Problem

P2: "Worktrees keep files apart. They don't keep simulators apart." Several agents share Metro's 8081 and one device, so "the simulator silently showed that branch's bundle", and the 8081 prompt blocks headless agents (rn-dev-agent#582, flowdeck, Stim#847). ZLI already has per-worktree leases (`DeviceLeases.ts`), but every worktree's Metro collides on 8081, `expoServer()` only looks at 8081, 19000, and 19006 (`apps/web/src/mobile/mobile.ts:280-297`), and nothing checks which worktree a Metro server belongs to.

### Scope

In:
1. A deterministic Metro port per worktree: the project's own checkout keeps 8081, and worktrees get a port from 8100-8199.
2. `ZLI_METRO_PORT` and `RCT_METRO_PORT` in every terminal and agent of that worktree.
3. A port owner check: which worktree's folder the listener on a port runs from.
4. Dev-client pinning: open `<scheme>://expo-development-client/?url=http%3A%2F%2Flocalhost%3A<port>` when the project uses `expo-dev-client`, otherwise `exp://localhost:<port>`.
5. Android emulators that an agent boots use the worktree's preferred console port. When the device is leased to that worktree, map the device's `localhost:8081` to the worktree's Metro port (`adb reverse tcp:8081 tcp:<port>`), so an app built for 8081 reaches the right Metro.
6. The `mobile_workspace` agent tool, and UI that shows the port and owner.

Out: iOS simulator cloning, DerivedData, build slots, `ANDROID_SERIAL`, and starting Metro for the agent.

### Contracts: `packages/contracts/src/mobileWorkspace.ts` (S1)

```ts
export const METRO_DEFAULT_PORT = 8081;
export const METRO_BAND = { first: 8100, size: 100 } as const;
export const EMULATOR_BAND = { first: 5556, size: 15 } as const; // even ports 5556..5584; 5554 stays free for the person
/** Same answer in the server, the desktop, and the renderer. Earlier worktrees in `worktrees` keep their port on collision. */
export function metroPortFor(worktreeId: string, worktrees: readonly Pick<WorktreeProjection, "worktreeId" | "kind" | "status">[]): number;
export function emulatorPortFor(worktreeId: string, worktrees: readonly Pick<WorktreeProjection, "worktreeId" | "kind" | "status">[]): number | undefined;
```

Algorithm:
- `kind === "checkout"` gets 8081.
- Otherwise walk the non-cancelled worktrees in projection order, which is creation order. Each gets `first + fnv1a32(worktreeId) % size`, probing forward (with wraparound) past ports already given to earlier worktrees. Past `size` worktrees, it falls back to the bare hash.
- The emulator port is the same walk over `size` even ports, returning `undefined` when they are all taken.
- Pure, with no I/O.

Also in this file:

```ts
export const MetroOwner = z.discriminatedUnion("state", [
  z.object({ state: z.literal("free") }),
  z.object({ state: z.literal("this-worktree"), pid: z.number() }),
  z.object({ state: z.literal("other-worktree"), pid: z.number(), worktreeId: z.string(), branch: z.string() }),
  z.object({ state: z.literal("other-process"), pid: z.number().optional() }),
  z.object({ state: z.literal("unknown"), reason: z.string().max(200) }),
]);
export const MobileWorkspace = z.object({
  worktreeId: z.string(), branch: z.string(), metroPort: z.number().int(), emulatorPort: z.number().int().optional(),
  metro: MetroOwner, devClient: z.boolean(), scheme: z.string().max(100).optional(),
  openUrl: z.string().max(500),        // dev-client or exp:// URL for this worktree's port
  deviceId: z.string().optional(),     // device this worktree's agent holds
});
export const MobileWorkspaceInput = z.object({ worktreeId: z.string() });
```

### Server (S1 only)

- `apps/server/src/daemon-entry.ts:215`: add `ZLI_METRO_PORT` and `RCT_METRO_PORT`, each `(value) => /^[0-9]{4,5}$/u.test(value) && Number(value) >= 1024 && Number(value) <= 65535`.
- New `apps/server/src/mobile/metroEnv.ts`: `metroEnv(worktreeId, worktrees)` returns `{}` for a checkout, otherwise `{ ZLI_METRO_PORT: p, RCT_METRO_PORT: p }`. It is merged in three places:
  - `terminal/TerminalReactor.ts:152` `envOverrides`, after `browserToolEnv`. It applies to every terminal in the worktree, so the person's shells match the agent's.
  - `providers/registerProviders.ts:171`.
  - `providers/AcpProviderAdapter.ts:91`.

  Get `worktrees` from the same projection or store these classes already read for `worktreePath`.
- Before relying on `RCT_METRO_PORT`, check that `@expo/cli` honors it for `expo start` (read `node_modules/@expo/cli` in any Expo fixture, or Expo docs). If it does not, the agent text below still tells agents to pass `--port $ZLI_METRO_PORT`.

### Desktop (S1)

- `mobile/dev/workspace/portOwner.ts`: `metroOwner(port, worktrees, host)`.
  - macOS and Linux: `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fp` gives the pid. Then `lsof -a -p <pid> -d cwd -Fn`, or on Linux `readlink /proc/<pid>/cwd` through `fs`, gives the folder. A listener whose cwd is inside a worktree path (realpath, prefix with a separator) belongs to that worktree.
  - Without `lsof` on Linux, fall back to `ss -ltnpH "sport = :<port>"`.
  - Windows: `{ state: "unknown", reason: "Port owners are not checked on Windows yet." }`.
  - Read-only, 3 s timeout.
- `mobile/dev/workspace/projectInfo.ts`: reads `package.json` (`expo-dev-client` in dependencies or devDependencies), `app.json` `expo.scheme`, and a static `app.config.json`. It never evaluates `app.config.js`. It checks the worktree root and `apps/*/` and `packages/*/` one level down, skipping `node_modules`.
- `mobile/dev/workspace/index.ts`:
  - Actions: `mobileworkspace` returns `MobileWorkspace` for the caller's worktree (via `context.ownerFor`).
  - IPC: `zli:mobile:workspace:get` `{worktreeId}` and `zli:mobile:workspace:list` (all live worktrees, for Settings).
  - `testOps`: `metro-owner` (sets a fake answer).
- `MobileControlActions.ts`, the `mobileboot` and `mobileopenurl` cases only (S1 owns both): in `mobileboot`, pass `preferredPort: emulatorPortFor(worktreeId, worktrees)` into `manager().boot`.
- `DeviceManager.boot` and `MobileDriver` boot options (S1 owns the boot signature): add `preferredPort?: number`. `AndroidDriver.boot` (`AndroidDriver.ts:121-140`) uses `preferredPort` when it is free in the current serial list, and otherwise falls back to `freeEmulatorPort`.
- The `adb reverse tcp:8081 tcp:<port>` mapping, in `DeviceManager.openUrl` and the agent `mobileopenurl` case: when the device is an Android **emulator**, the URL's port is the worktree's Metro port, and that port is not 8081, also run `adb -s <serial> reverse tcp:8081 tcp:<port>`. Physical phones are left alone. Add a `reverseExtra` helper in `adb.ts`.

### Agent tool: `mobile-tool/dev/workspace.ts`

```
name: "mobile_workspace", title: "This worktree's Metro port and device", readOnly: true,
description: "Your worktree's own Metro port, which ZLI also sets as ZLI_METRO_PORT and RCT_METRO_PORT in your terminal, who is listening on it, the URL that opens your app on a device, and the device you hold. Other worktrees use other ports, so never start Metro on 8081 from a worktree."
instructions: "Start Metro on your worktree's port: npx expo start --port $ZLI_METRO_PORT (add --dev-client for a development build), or npx react-native start --port $ZLI_METRO_PORT. Call mobile_workspace to get the URL to open on the device."
```

Format it as short text, for example: `Metro port 8142 (free). Open with myapp://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8142. Device: android:emulator-5560.`

### UI

- `apps/web/src/mobile/dev/workspace/WorkspaceBanner.tsx`: shown when this worktree's port is held by another worktree or another process.
  - Amber `banner-warning`: "Port 8142 is served from feat-login, not this worktree. Opening it would show that branch's app." or "Another program is using port 8142, this worktree's Metro port."
  - No action button.
- `ExpoBanner.tsx` and `mobile.ts` `expoServer()` (S1 owns both): accept `metroPort` and include it in the detected ports. The banner says "Metro for this worktree is on localhost:8142", and **Open** uses `workspace.openUrl`. When the owner is another worktree, disable Open with the tooltip "Port 8142 belongs to feat-login".
- `WorkspaceProjectGroup.tsx` (project view), group title "This worktree":
  - Row "Metro port", description "Set as RCT_METRO_PORT in this worktree's terminals.", value `8142` in mono with the owner badge: Free, Running here (green), Used by feat-login (amber), Used by another program (amber), Not checked (quiet).
  - Row "Open on a device", description "Development build" or "Expo Go", value the URL in mono, truncated, with a Copy icon button labelled "Copy URL".
  - Row "Emulator port", value `emulator-5560`, or "Any free port".
- `WorktreesSettingGroup.tsx` (Settings > Mobile), group title "Worktrees", description "Each worktree gets its own Metro port so agents never test another branch's app." One row per worktree: branch in mono, the end of the path in dim text, the port in mono, and the owner badge.

### Graceful degradation on Linux with no adb or xcrun

The port allocation, env, tool, and UI work fully. The owner check works with `lsof` or `ss` or `/proc`, and reports Not checked otherwise. The emulator port and reverse steps are skipped when there is no Android device.

### Tests

- `packages/contracts/src/mobileWorkspace.test.ts`: the checkout gets 8081. Stability when a later worktree is added. Collision probing (pick ids with the same hash). Wraparound. Cancelled worktrees are ignored. The emulator band is exhausted.
- `apps/server/src/daemon-entry.test.ts`: the two keys accept `8142` and reject `80`, `abc`, `99999`, and `8142;rm`.
- `TerminalReactor.test.ts`: `envOverrides` includes both keys for a worktree and none for a checkout. Matching assertions for `registerProviders` and `AcpProviderAdapter`, in their existing test files.
- `NodePtyFactory.test.ts`: the existing token-deletion test still passes with the new keys present.
- `portOwner.test.ts` with `FakeProcessRunner` (`lsof -Fp`/`-Fn` fixtures) and a fake fs for `/proc`: each state, timeouts, missing `lsof`, and Windows.
- `projectInfo.test.ts` with a fake fs: the dev-client flag, the scheme, and a monorepo app dir.
- `AndroidDriver.test.ts`: `preferredPort` used, and taken-port fallback. `DeviceManager.test.ts`: the extra reverse for emulators only.
- `WorkspaceBanner.test.tsx`, `ExpoBanner.test.tsx`, `WorktreesSettingGroup.test.tsx`: copy and states.
- e2e `tests/e2e/mobile-workspace.spec.ts`: create a worktree, open the project view, and see a port in 8100-8199. Use the `metro-owner` test op to set "other-worktree" and see the banner text. Open a terminal in the worktree, run `echo $RCT_METRO_PORT`, and see the same port. Then assert `ZLI_RUNTIME_TOKEN` is unset in that terminal (`echo "${ZLI_RUNTIME_TOKEN:-unset}"` prints `unset`).

### How S1 was built, where it differs from this section

- `@expo/cli` honors `RCT_METRO_PORT`: `resolveMetroPortAsync` reads it when `--port` is not given. The agent instructions still say `--port $ZLI_METRO_PORT`, which works for both Expo and React Native CLI.
- Codex chat agents get no Metro port. One Codex app server serves every thread, so its environment has no single worktree. Claude Code, Cursor, Droid, and the ACP agents get both keys. `registerProviders` takes a `metroEnv(worktreeId)` option, which `apps/server/src/main.ts` wires to the engine projection (one line outside S1's files).
- `TerminalReactor` keeps the worktree list from `worktree.*` events instead of reading the projection at each launch, because a projection read queues behind engine commands and slowed every terminal start. A worktree it has not seen yet still falls back to a projection read.
- `MobileWorkspace` has two optional extra fields, `path` and `checkout`, so Settings can show the end of the path and the project view can say when the checkout keeps 8081. The contracts file also exports `MobileWorkspaceOpened`, `MobileWorkspaceChanged`, and `MobileWorkspaceTestMetroOwner` for the extra IPC below.
- Two extra IPC channels: `zli:mobile:workspace:open` opens `openUrl` on a device, and refuses with 409 when another worktree holds the port. `zli:mobile:workspace:changed` is sent after the `metro-owner` test op, so open views refresh without waiting for the 10 s poll.
- The `mobile_workspace` text adds the emulator port line, and a warning not to open the URL when another worktree or program holds the port.
- `expoServer()` accepts any port in `METRO_BAND` as well as the optional `metroPort` argument. `MobilePane.tsx` does not pass `metroPort`; band detection covers it, and the only S0 change is one line passing `worktreeId` to `ExpoBanner`.
- `adb.ts` `localhostPort` reads the port from the inner `url` parameter of a dev-client link, so dev-client URLs get forwarding and the 8081 mapping too.
- The 8081 mapping lives in a new `AndroidDriver.reverse(device, devicePort, hostPort)` and a public `DeviceManager.mapMetro(device, url, metroPort)`. `DeviceManager.openUrl` takes `{ metroPort }` and returns `mapped8081To`, which the opened notice mentions.
- The web side adds `useWorkspace.ts` (the shared hook, owner badge, and warning copy) and `fakeWorkspace.ts` (a test fixture) next to the files listed above.
- Hardware-only checks for this feature are in `apps/web/src/mobile/MANUAL_TEST.md` under "Per-worktree Metro port".

---

## 6. F2: Mobile doctor and the AGENTS.md block (stream S2)

### Problem

P3 (version drift: agents write "what was correct three years ago", AGP 9, Expo SDK 55+), P8 (Expo Go vs dev build; App Store Expo Go stops at SDK 54), P9 (`newArchEnabled=false` fails on SDK 55+), and P11 (each agent needs its own setup). ZLI writes no project facts for agents today. Its only channel is the MCP `instructions` string (audit section 3).

### Scope

In:
- Static project reads, read-only host probes, and an optional deep Expo check behind a click.
- A table of known-bad combinations, a toolchain fingerprint, and signing state (counts and presence only).
- A `zli:mobile` block for AGENTS.md (or CLAUDE.md), created as a file-block proposal.
- The `mobile_doctor` tool and the project view group.

Out: running `expo-doctor` without a click, Flutter deep checks (static Flutter facts are in), EAS credentials calls, editing any file other than through a proposal, and reading keystore or certificate contents.

### Contracts: `packages/contracts/src/mobileDoctor.ts` (S2)

- `MobileProjectFacts = MobileProjectFactsCore.extend({ ... })` with these optional fields:
  - `client: { kind: "expo-go" | "dev-build" | "bare" | "unknown", reason }`
  - `newArch: { enabled?: boolean, source?: string }`
  - `appIds: { android?, ios?, scheme? }`
  - `android: { gradle?, agp?, kotlin?, builtInKotlinOptOut?: boolean, newDslOptOut?: boolean }`
  - `ios: { podfile: boolean, podsDrift?: boolean, deploymentTarget? }`
  - `signing: { android: "debug-only" | "release-config" | "eas" | "unknown", ios: { identities: number } | "not-checked" }`
  - `host: Record<tool, version | "not found">`
  - `deep?: { ranAt, expoInstallCheck?: { ok, packages: string[] }, expoDoctor?: { ok, failures: string[] } }`
- `MobileDoctorInput = { worktreeId }`, `MobileDoctorDeepPlan = { commands: string[] }` (shown before running), and `MobileAgentsBlockPreview = { file, content, proposalId }`.

### Desktop: `apps/desktop/src/mobile/dev/doctor/`

- `readProject.ts`:
  - Reads with `MobileFileSystem`: `package.json` and lockfile versions (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`; regex extraction, no full YAML parse), `app.json` and `app.config.json` (static only), and `eas.json`.
  - Android: `android/gradle/wrapper/gradle-wrapper.properties`, `android/build.gradle(.kts)`, `android/settings.gradle(.kts)`, `gradle/libs.versions.toml`, `android/gradle.properties`, and `android/app/build.gradle(.kts)` (`signingConfigs { release`).
  - iOS: `ios/Podfile`, `ios/Podfile.lock` vs `ios/Pods/Manifest.lock`, and `project.pbxproj` (`IPHONEOS_DEPLOYMENT_TARGET`, `DEVELOPMENT_TEAM` presence only).
  - Flutter: `pubspec.yaml` and `pubspec.lock`.
  - The app dir is found the same way as F1's `projectInfo`. S2 copies the 15-line finder rather than importing S1's file, so the streams stay independent; dedupe it after merge.
- `probes.ts`: `node -v`, `java -version` (stderr), `adb version`, `xcodebuild -version` and `pod --version` (macOS only), and `security find-identity -v -p codesigning` (macOS; keep only the "N valid identities found" count). Each takes 5 s, runs through `host.runner` with `host.env`, and is cached for 60 s.
- `knownIssues.ts`: a data table of `{ id, when(facts), severity, title, detail, fix?, source }`, at least:
  - `expo-sdk-rn-mismatch`: Expo 55→RN 0.83, 56→0.85, 57→0.86. Warning. Fix: proposal `npx expo install --fix` with `CI=1`.
  - `newarch-optout-removed`: SDK ≥ 55 or RN ≥ 0.82 with `newArchEnabled` false in `app.json` or `gradle.properties`. Error: "SDK 55 and later cannot turn off the New Architecture, so this build fails."
  - `expo-go-sdk55`: SDK ≥ 55 without `expo-dev-client`. Warning: "The App Store's Expo Go stops at SDK 54. Use a development build on a physical iPhone."
  - `jdk-too-old`: RN ≥ 0.73 with Java < 17. Error.
  - `agp9-optout-flags`: AGP ≥ 9 with `android.builtInKotlin=false` or `android.newDsl=false`. Warning: "Google says these opt-out flags stop working in summer 2026."
  - `pods-drift`: `Podfile.lock` ≠ `Manifest.lock`. Warning. Fix: proposal `pod install` with cwd `ios`.
  - `cocoapods-trunk`: any Podfile. Info: "CocoaPods trunk becomes read-only on December 2, 2026."
  - `npm-install-in-expo`: an Expo project. Info, for the block: "Install packages with npx expo install."

  Each row cites the source URL from the research doc.
- `fingerprint.ts`: sha256 of the sorted `versions` map, as 12 hex characters.
- `deepCheck.ts`: `plan()` returns the exact lines, and `run(worktreeId)` executes them only through the IPC `zli:mobile:doctor:deep-run`, which the renderer calls only from the Run Expo checks button. The lines are `npx --no-install expo config --json --type public`, `CI=1 npx --no-install expo install --check`, and `npx --no-install expo-doctor`. A missing local binary reports "Not installed in this project". Each has a 60 s timeout, and `expo-doctor` lines are parsed defensively (`✖`).
- `agentsBlock.ts`: `renderBlock(facts)` returns project-level facts only, never per-worktree ports. The block is committed to git and shared across branches, so ports go through `mobile_workspace`. It has no date, so re-running does not churn the file. Example:

  ```markdown
  <!-- zli:mobile:start -->
  ### Mobile (written by ZLI; edit outside these markers)
  - Expo SDK 56 (react-native 0.85.1), development build (expo-dev-client), New Architecture on.
  - Install packages with `npx expo install <pkg>`, never plain `npm install`. Check new packages with the zli-mobile tool mobile_check_package first.
  - Each worktree has its own Metro port in `$ZLI_METRO_PORT`; start Metro with `--port $ZLI_METRO_PORT`. Ask mobile_workspace for the URL to open.
  - Do not set newArchEnabled=false; this SDK cannot turn it off.
  - Verify UI changes on a device with mobile_screenshot and mobile_snapshot before saying they work.
  - When a build fails, call mobile_build_brief with the log before changing versions. Never downgrade a package or silence an error just to make the build pass.
  - Toolchain fingerprint: 3fa9c21b07de.
  <!-- zli:mobile:end -->
  ```

  `proposeBlock(worktreeId)` picks the file: `AGENTS.md` if present, otherwise `CLAUDE.md` if present, otherwise a new `AGENTS.md`. It computes `baseDigest` and creates a `file-block` proposal with `source: "zli"` and `sourceLabel: "Project check"`. If the current block already equals the new content, it returns `{ upToDate: true }` and creates nothing.
- `facts.ts` (fills the S0 stub): `projectFacts(host, worktreeId)` merges `readProject`, `probes`, and `knownIssues`, and is cached until a watched file's mtime changes or 60 s pass.
- `index.ts`:
  - Actions: `mobiledoctor` returns the facts for the caller's worktree, including the last deep results, and never runs deep checks.
  - IPC: `zli:mobile:doctor:check` `{worktreeId, refresh?}`, `zli:mobile:doctor:deep-plan`, `zli:mobile:doctor:deep-run`, `zli:mobile:doctor:propose-block`, and `zli:mobile:doctor:propose-fix` `{worktreeId, findingId}`. The last creates a proposal from that finding's `fix`.

### Agent tool: `mobile-tool/dev/doctor.ts`

```
name: "mobile_doctor", title: "Check the mobile project", readOnly: true,
description: "The app's real versions (Expo SDK, React Native, Gradle, AGP, Kotlin, Java, Xcode, CocoaPods), whether it runs in Expo Go or a development build, signing setup, and known problems with fixes. Read this before changing versions or native config; your training data may be older than this project."
```

Format: one line per version, then the findings ordered errors first. Each finding with a fix ends with "Fix: <command>. Propose it with mobile_propose; do not run it yourself."

### UI: `apps/web/src/mobile/dev/doctor/DoctorGroup.tsx` (project view)

- Group title "Toolchain", with a ghost **Check again** button (icon `reload`).
- While loading: LoadingState "Checking this project".
- One row per version: label, then the value in mono, or the quiet badge "Not found".
- Row "Runs in": Development build, Expo Go, or Native project, with the reason as the description.
- Row "Signing": "Android: debug key only. iPhone: 2 signing identities." or "iPhone: not checked on this computer."
- Findings follow as rows with a severity badge (red Error, amber Warning, quiet Note), title, and detail. A finding with a fix has a **Propose fix** button, which creates the proposal card. It never runs anything directly.
- Row "Expo checks", description "Runs expo config, expo install --check, and expo-doctor from this project. They run the project's own code." The ghost button **Run Expo checks** first expands a mono well listing the three exact commands with **Run** and **Cancel**, then shows the results inline.
- Row "Agent notes", description "Adds what agents need to know to AGENTS.md, between zli:mobile markers. You see the change before anything is written." Button **Prepare notes**, which creates the file-block proposal card. When the block is current, a quiet badge "Up to date".

### Graceful degradation

On Linux with no adb, Java, or Xcode, static facts still come from files. The probes show "Not found", iOS rows say "Not checked on this computer", and no row is an error. With no `package.json` and no native folders, the group shows "No mobile app found in this worktree. ZLI looks for Expo, React Native, Flutter, Android, and Xcode projects."

### Tests

- Fixture projects under `apps/desktop/src/mobile/dev/doctor/fixtures/`: `expo56-devclient`, `expo55-newarch-off`, `rn-bare-0.85`, `flutter`, `native-android-agp9-optout`, `ios-pods-drift`, and `monorepo-apps-mobile`. Each holds only the files read.
- Tests:
  - `readProject.test.ts`: every fixture parses, including `.kts` variants and a malformed file reported as unknown.
  - `knownIssues.test.ts`: each rule fires and does not fire.
  - `probes.test.ts`: `FakeProcessRunner` answers, a missing tool, timeouts, the `security` count only, and `host.env` passed (assert no `ZLI_RUNTIME_TOKEN` key).
  - `deepCheck.test.ts`: runs only through `run`, and parses the outputs.
  - `agentsBlock.test.ts`: stable output, no ports, and proposal creation for each of the three file cases plus up-to-date.
  - `mobileIpc` and `MobileControlActions`: the doctor cases.
  - `DoctorGroup.test.tsx`: copy, Propose fix creates a proposal and runs nothing, and the deep plan is shown before running.
- e2e `tests/e2e/mobile-doctor.spec.ts`: write an `expo55-newarch-off`-style `package.json` and `app.json` into the test repo, open the project view, and see the "cannot turn off the New Architecture" error. Click Prepare notes, see the proposal card, click Write to AGENTS.md, and assert the file contains both markers and that a second Prepare notes shows "Up to date".

### How S2 built F2, where it differs from this section

- Proposals from the doctor use `sourceLabel: "From the project check"`, matching the label S0 shipped, instead of "Project check".
- `MobileProjectFacts` carries more than listed: `newArch.disabledIn` (the files that still set `newArchEnabled` false), `ios.developmentTeam` (presence only), `packageManager`, `devClient`, `projectFingerprint` (project versions only), `notes { file, state }`, and `unreadable` (files ZLI could not parse). On SDK 55 and later `newArch.enabled` is true even when `app.json` says false, because the SDK ignores the flag.
- `deep` steps have a `state` (`passed`, `failed`, `not-installed`, `timed-out`) and `detail` instead of `ok`, and `expoConfig` is reported too. `MobileDoctorDeepPlan` also has `folder`. `MobileAgentsBlockPreview` became `MobileAgentsBlockResult`, `{ upToDate: true, file }` or `{ upToDate: false, file, proposalId }`.
- `facts.ts` reads the files on every call instead of caching by mtime, so an edit shows at once; only the host probes are cached for 60 s. `projectFacts(host, worktreeId, { refresh })` takes an optional third argument that skips that cache. The two-argument form still works.
- `knownIssues.ts` adds `expo-install-check` (from the last Expo checks, fix `npx expo install --fix`) and `unreadable:<file>`. `expo-go-sdk55` offers the fix `npx expo install expo-dev-client`.
- The block ends with "Project versions fingerprint" built from project versions only, so two computers with different Node or Java versions write the same block. The host fingerprint stays in `fingerprint` for agents.
- The doctor's agent and IPC cases are tested in `doctor/index.test.ts` and `doctor/preload.test.ts` instead of S0's `mobileIpc.test.ts` and `MobileControlActions.test.ts`.

---

## 7. F3: Package guard (stream S2)

### Problem

P9 (unmigrated and unmaintained packages break New Architecture builds; agents suggest legacy packages) and P3 (plain `npm install` "is how you end up with a native module that doesn't match your SDK").

### Scope

In: checking up to 20 package names against React Native Directory, the six guard rules from research Part 2 section 6, the install command proposal, the `mobile_check_package` tool, and the project view group.

Out: intercepting an agent's own `npm install`, npm tarball inspection, and alternatives search (later).

### Contracts: `packages/contracts/src/mobilePackages.ts` (S2)

`MobilePackageVerdict = { name, verdict: "ok" | "warn" | "block" | "unchecked", reasons: string[], newArchitecture?, expoGo?, configPlugin?, unmaintained?, latest? }`, `MobilePackageCheck = { verdicts, install?: MobileProposalAction }`, and `MobileCheckPackageInput = MobileControlDeviceInput.extend({ packages: z.array(npmName).min(1).max(20) })`, where `npmName` is `/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/` with an optional `@version` suffix.

### Desktop: `apps/desktop/src/mobile/dev/packages/`

- `directory.ts`:
  - `GET https://reactnative.directory/api/libraries/check?packages=<comma list>`, then for at most 5 names `GET /api/library?name=<n>` to read `expoGo`, `github.configPlugin`, and `github.isArchived`.
  - Through `host.fetch`, with a 5 s timeout, a cache of 1 hour per name, and responses validated with zod (unknown fields ignored).
  - Offline, a timeout, or non-200 makes every name `unchecked` with the reason "React Native Directory could not be reached; this package was not checked."
- `rules.ts`: the six research rules, using `projectFacts` (S2's own doctor) for New Architecture, Expo, and Expo Go state.
  1. Not in the directory: warn.
  2. `newArchitecture` untested or false while New Architecture is on: block. `new-arch-only` while it is off: block.
  3. `unmaintained` or archived: warn.
  4. `expoGo: false` in an Expo Go project: warn, "needs a development build".
  5. `configPlugin: true`: a reason "Add it to plugins in app.json and rebuild."
  6. The install command: Expo projects use `npx expo install <names>`, otherwise the lockfile's manager (`pnpm add`, `yarn add`, `bun add`, `npm install`). Blocked names are left out of the command.
- `index.ts`: the action `mobilecheckpackage`, and the IPC `zli:mobile:packages:check` and `zli:mobile:packages:propose-install` `{worktreeId, packages}`.

### Agent tool: `mobile-tool/dev/packages.ts`

```
name: "mobile_check_package", title: "Check packages before installing", readOnly: true,
description: "Check npm packages against React Native Directory before adding them: New Architecture support, Expo Go support, config plugins, and whether they are maintained. Returns the install command that picks versions matching this project's SDK. Propose that command with mobile_propose instead of running npm install."
```

### UI: `apps/web/src/mobile/dev/packages/PackagesGroup.tsx`

- Group title "Packages".
- A `Field` "Check packages", hint "Names separated by spaces, such as react-native-mmkv expo-camera.", and a **Check** button.
- Results: one row per package, with a badge (green Fine, amber Warning, red Blocked, quiet Not checked) and the reasons.
- Then the command in a mono well and **Propose install**, which creates a card. It is disabled with the tooltip "Every package was blocked" when none remain.

### Degradation

With no network, every package shows Not checked and the install command is still offered. Nothing blocks on missing data.

### Tests

- `directory.test.ts`: fetch fakes with canned JSON from research Part 2 (reanimated supported, vision-camera new-arch-only, react-native-fs unmaintained and untested), plus 500, a timeout, and malformed JSON.
- `rules.test.ts`: each rule, with Expo and bare package managers.
- `PackagesGroup.test.tsx`.
- e2e: covered in `mobile-doctor.spec.ts` with the network blocked. With `ZLI_TEST_MOBILE=fake`, the fake host's `fetch` returns canned JSON keyed by URL (test op `fetch-answer`). Check `react-native-fs`, see Warning, and click Propose install to see the card.

### How S2 built F3, where it differs from this section

- `MobilePackageCheck` also has `command`, the install line as the person reads it.
- Rule 2 also warns, rather than blocks, when the doctor cannot tell whether the New Architecture is on. On SDK 55 and later it is always on, so an untested package such as `react-native-fs` is blocked there. The e2e test answers the directory with `react-native-fs` as unmaintained only, so it shows Warning as described above.
- The proposal uses `sourceLabel: "From the project check"`, like F2.

---

## 8. F4: Live device log with crash detection (stream S3)

### Problem

P6: "This crash never shows up in Metro. Only Logcat knows the truth." Today `mobile_logs` is one-shot `logcat -d` (at most 2,000 lines), and filtering by `appId` fails once the app has died, so crashes vanish from the filtered view (`AndroidDriver.ts:315-324`, audit section 5).

### Scope

In:
- A streaming log reader per online device, and a crash detector.
- Crash reports kept per device. A pull notice on the next zli-mobile result of the agent that holds the device.
- `mobile_crashes`, a crash card in the Mobile panel with **Send to agent**, and the `crashWatch` setting.

Out:
- Automatic messages into chat (the person clicks Send to agent).
- Symbolication, R8 mapping.
- iOS crash report files from `~/Library/Logs/DiagnosticReports` (later; the iOS stream detects uncaught exceptions only).

### Contracts: `packages/contracts/src/mobileLogs.ts` (S3; shared with F5)

`MobileCrashReport = { crashId, deviceId, appId?, kind: "java" | "native" | "anr" | "ios-exception" | "js-error", title (≤300), frames: string[] (≤8), tail: string[] (≤30), firstSeen, lastSeen, count, heldBy? }`, the event `MobileCrashEvent = { deviceId, reports }`, and `MobileControlCrashesInput = MobileControlDeviceInput`.

### Desktop

- `MobileDriver.ts` (S3 owns the new method, appended at the end of the interface): `streamLogs(device): LogStream`, where `LogStream = { onLine(listener): void; stop(): void; exited: Promise<void> }`.
  - `AndroidDriver`: `adb -s <serial> logcat -v threadtime -T 1 -b main -b crash` through `runner.spawn`, split into lines (keep a partial line across chunks).
  - `IosSimulatorDriver`: `xcrun simctl spawn <udid> log stream --style compact --level error`.
  - `FakeDriver`: an `emitLog(lines)` test method.
- `mobile/dev/crash/detector.ts`: a pure state machine over lines.
  - Signatures: `FATAL EXCEPTION`, `AndroidRuntime: Shutting down VM`, `Process: <pkg>, PID: <n>`, `ANR in <pkg>`, `Fatal signal \d+ \(SIG` plus `DEBUG   : backtrace:`, `Terminating app due to uncaught exception`, `EXC_BAD_ACCESS`, `ReactNativeJS: .*(Invariant Violation|TypeError|ReferenceError)`, and `com.facebook.react.common.JavascriptException`.
  - A block ends after 40 frame lines or 300 ms of other tags, judged by timestamp.
  - The signature is the exception class plus the first 3 frames from the app's package (or the first 3 frames). Repeats bump `count`.
- `mobile/dev/crash/CrashWatcher.ts`:
  - Starts a stream when `settings.crashWatch` is on and the device is online, and either an agent holds it or the panel shows it (DeviceManager viewers).
  - Stops when the device goes offline, the setting goes off, or 2 minutes pass with neither condition.
  - Keeps a 500-line ring buffer, so the report `tail` comes from real context, and the last 20 reports per device.
  - Restarts a dead stream at most 3 times, with backoff 1 s, 5 s, 15 s.
  - Emits `zli:mobile:crash` events, throttled to 1 per second per device.
- `mobile/dev/crash/index.ts`:
  - Actions: `mobilecrashes` returns the reports for the caller's device (`context.online`).
  - `decorate`: when the owner's leased device has a report newer than that owner's last decorated result, append to the action's result the field `crashNotice: "The app crashed 12 s ago: java.lang.IllegalStateException: … Call mobile_crashes for the stack."`. It appears once per crash per owner. The MCP formatter adds it as a text line.
  - IPC: `zli:mobile:crash:list` `{deviceId}`, `zli:mobile:crash:dismiss` `{deviceId, crashId}`, and the event `zli:mobile:crash`.
  - `testOps`: `emit-log` `{deviceId, lines}`, which calls `FakeDriver.emitLog`.

### Agent tool: `mobile-tool/dev/crash.ts`

```
name: "mobile_crashes", title: "Read app crashes", readOnly: true,
description: "Crashes and ANRs ZLI caught in the device log while you used it: the exception, the top stack frames, and the log lines before it. Native crashes never reach Metro, so check this when the app closes, freezes, or stays on the splash screen."
```

Format: `title`, the frames indented, then `Last 30 log lines:` and the tail. That is about 2 KB per report, at most 3 reports.

### UI

- `apps/web/src/mobile/dev/crash/CrashBanner.tsx`, shown for the selected device's newest undismissed report:
  - A red `banner-danger`: "com.example.app crashed: IllegalStateException: Fragment not attached" with `×3` when `count` > 1.
  - A **Show details** toggle expands the frames and tail in a mono well with a max height of 200px that scrolls.
  - Actions: **Send to agent**, which uses `sendToWorktreeAgent` with a compact card text (title, frames, last 30 lines, "Caught by ZLI from the device log.") and shows the notice "Sent to the agent in feat-login". With no chat agent, it is disabled with the tooltip "No chat agent works in this worktree". Also **Copy report** and **Dismiss** (icon `x`, label "Dismiss crash").
- `MobileLogsDrawer.tsx` (S3 owns it): lines inside a detected crash block get the class `is-crash` (red text).
- `CrashWatchSettingGroup.tsx` (Settings > Mobile), group "Crash watch": Switch **Watch for crashes**, hint "While a device runs, ZLI reads its log for crashes and tells the agent using it. Nothing goes into a chat unless you choose Send to agent."

### Degradation

With no devices, nothing starts and no UI shows. `mobile_crashes` returns the existing 409 "No running device is free…". A stream that cannot spawn (adb missing) is logged once, and the watcher stays off for that device.

### Tests

- `detector.test.ts`, with fixtures `crash/fixtures/{java-fatal,anr,native-sigsegv,rn-js-error,ios-uncaught,noise-only}.log`: titles, frames, dedupe, the end of a block, and no false positive on `noise-only`.
- `CrashWatcher.test.ts`: `FakeProcessRunner` and `FakeProcess.emit` with chunk splits mid-line, start and stop conditions, restart backoff (fake timers), throttling, and the ring buffer.
- `MobileControlActions.test.ts`: `crashNotice` is added once per owner.
- `AndroidDriver.test.ts`: the `streamLogs` args.
- `CrashBanner.test.tsx`: Send to agent calls the helper, and the state with no agent.
- e2e `tests/e2e/mobile-crash.spec.ts` (fake mode): open Mobile and call the test op `emit-log` with the `java-fatal` fixture lines. See the crash banner title, click Show details, see the frames, and click Dismiss so the banner goes away.

---

## 9. F5: Build-failure classifier and agent brief (stream S3)

### Problem

P4: the agent must "parse thousands of lines… hope it found the actual error". EAS says "the earliest phase with errors will contain the most useful information". P3: version drift is a common root cause, so checks come first. P5: agents "make a red build go green" by downgrading or silencing, so the brief says what not to do.

### Scope

In: classifying pasted text or a log file (Gradle, Xcode, EAS, Metro), a brief that leads with version-check findings from the doctor, and the suggested first command as a proposal.

Out: running builds, fetching EAS logs (later), and `xcresulttool` parsing (later).

### Contracts (in `mobileLogs.ts`)

- `MobileBuildBrief = { stack: "gradle" | "xcode" | "eas" | "metro" | "unknown", category, confidence: "high" | "medium" | "low", firstError: { line, lineNumber, context: string[] (≤41) }, phase?, versionFindings: MobileFinding[], likelyFiles: string[], avoid: string[], suggestion?: { text, action?: MobileProposalAction }, text }`. `text` is the ready-to-send brief, at most 4,000 characters.
- `MobileBuildBriefInput = MobileControlDeviceInput.extend({ log: z.string().max(2_000_000).optional(), logPath: z.string().max(1_000).optional() })`, with exactly one of them.

### Desktop: `apps/desktop/src/mobile/dev/build/`

- `classify.ts`: table-driven rules, one per class from research Part 2 section 4.
  - The classes: version mismatch, JDK/Gradle, autolinking/native module, CocoaPods, signing, New Architecture/codegen, config plugin, memory/infra, plus `unknown`.
  - Detect the stack: `> Task :` or `What went wrong:` means Gradle. `** BUILD FAILED **` or `error: ` with `.swift:` means Xcode. `[RUN_GRADLEW]`/`[INSTALL_PODS]` phase headers or `eas build` mean EAS. `Unable to resolve module` means Metro.
  - The first error is the earliest match of the class signature, else the first `FAILURE:`/`error:` line. Phases come from EAS `[PHASE]` headers or the Gradle `> Task :app:… FAILED` line.
  - Context is 20 lines on each side, ANSI codes stripped, and lines over 500 characters cut.
- `brief.ts`:
  1. `projectFacts(host, worktreeId)` (S2's `facts.ts`; it returns `undefined` until S2 merges, and then the brief says "Version checks did not run.").
  2. Classify.
  3. Pick likely files per class (for example signing → `android/app/build.gradle`, `eas.json`, `ios/*.xcodeproj/project.pbxproj`; codegen → `package.json` `codegenConfig`, `app.json` plugins).
  4. `avoid` per class:
     - Version: "Do not downgrade packages to make the error go away."
     - New Architecture: "Do not set newArchEnabled=false."
     - Signing: "Do not create or change certificates, profiles, or keystores; tell the person what is missing."
     - Every class: "Do not add @ts-ignore, @Suppress, try!, or skip tests to make the build pass."
  5. The suggestion, for example version class on Expo → `npx expo install --fix` with `CI=1`, CocoaPods → `pod install` in `ios`, JDK → text only ("Install JDK 17 and point JAVA_HOME to it").
  6. Render `text`.
- `logPath` safety: resolve it against the worktree. It must be inside the worktree path or the OS temp dir (realpath), at most 50 MB, and only the last 2 MB is read. Anything else gets 400 with "ZLI reads build logs only from this worktree or the temp folder."
- `index.ts`: the action `mobilebuildbrief`, and the IPC `zli:mobile:build:brief` `{worktreeId, log}` and `zli:mobile:build:propose` `{worktreeId, action}`. The second re-validates through the proposal schema and creates a `zli`-sourced proposal.

### Agent tool: `mobile-tool/dev/build.ts`

```
name: "mobile_build_brief", title: "Explain a build failure", readOnly: true,
description: "Give a failed Gradle, Xcode, EAS, or Metro log (text or a file path) and get the real first error with context, what kind of failure it is, this project's version problems, the files most likely involved, a first command to propose, and the shortcuts to avoid. Call this before changing versions or config to fix a build."
properties: { log: string, logPath: string }
```

The formatter returns `brief.text`. The suggestion line reads "Propose: <command> (mobile_propose)".

### UI: `apps/web/src/mobile/dev/build/BuildGroup.tsx` (project view)

- Group title "Build failure".
- A multiline `Field` "Build log", hint "Paste the end of a failed Gradle, Xcode, or EAS build. ZLI finds the first real error.", and an **Explain** button, disabled while the field is empty.
- The result:
  - A class `Badge` and the confidence in dim text.
  - The first error line in a mono well, with **Show context**.
  - "Version checks" rows, reusing the finding row component from S2 when it is merged, otherwise plain rows.
  - "Likely files" as mono list items, and "Avoid" as a list.
  - Actions: **Send to agent** (the same helper as F4), **Copy brief**, and, when there is a suggestion with an action, **Propose fix**, which creates the card.

### Degradation

Fully local. It works on Linux with no tools. Without doctor facts the brief says "Version checks did not run."

### Tests

- Fixtures in `build/fixtures/`, real-shaped logs of 200 to 2,000 lines each: `gradle-kotlin-metadata.log`, `gradle-unsupported-class-version.log`, `gradle-duplicate-class.log`, `gradle-java-heap.log`, `eas-pods-incompatible.log`, `eas-config-plugin.log`, `xcode-no-signing.log`, `xcode-provisioning.log`, `rn-codegen-turbomodule.log`, `metro-unable-to-resolve.log`, `unknown-noise.log`.
- `classify.test.ts`: per fixture, the expected stack, category, first error line number, and phase.
- `brief.test.ts`: facts present or absent, the `avoid` lines per class, suggestion actions that validate against `MobileProposalAction`, and the 4,000-character cap.
- `logPath.test.ts`: inside the worktree OK, `../` refused, a symlink out of the worktree refused, a large file read from the tail only.
- `BuildGroup.test.tsx`.
- e2e `tests/e2e/mobile-build.spec.ts` (a separate file, so S3 never edits S2's spec): paste the `gradle-unsupported-class-version` fixture, click Explain, see "JDK / Gradle" and the first error line, click Propose fix (when present), and see the card.

---

## 10. Parallel build plan

### Pattern: one scaffold first, then features in their own folders

Shared files cause conflicts when two branches insert at the same spot. So **S0 edits every shared file once**, adding a composition point that imports per-feature stub files. After S0 merges, each feature stream edits only its own new files, and it fills its stubs by replacing whole files that only it owns. The only edits to existing files outside the stream's own folders are listed per stream below, and no two streams list the same file.

```
Shared file                                   S0 adds                                         Streams then edit
packages/contracts/src/index.ts               exports for mobileDev/Workspace/Doctor/Packages/Logs  nobody
packages/contracts/src/mobile.ts              6 new actions, crashWatch setting               nobody
apps/desktop/src/mobile/MobileControlActions.ts  dev.actions dispatch + decorate              S1: the mobileboot and mobileopenurl cases only
apps/desktop/src/mobile/mobileIpc.ts          ...devIpcHandlers(dev)                          nobody
apps/desktop/src/preloadApi.ts                dev: createMobileDevApi(ipc)                    nobody
apps/desktop/src/main.ts                      createMobileDev wiring, mobileChildEnv, e2e fake hook  nobody
apps/desktop/src/mobile-tool/mcp.ts           ...MOBILE_DEV_MCP_TOOLS, dev formatters, instructions  nobody
apps/desktop/src/mobile-tool/cli.ts           generic dev-tool command                        nobody
apps/web/src/runtime/bridge.ts                dev?: MobileDevBridge                           nobody
apps/web/src/mobile/MobilePane.tsx            worktreeId prop, banners slot, Project check view  nobody
apps/web/src/settings/MobileSection.tsx       <MobileDevSettingGroups/> slot                  nobody
apps/web/src/settings/SettingsDialog.tsx      search keywords                                 nobody
apps/web/src/shell/AppShell.tsx               worktreeId to MobilePane                        nobody
```

The stub files S0 creates, which each stream fully owns and replaces:

| Owner | Stub files |
|---|---|
| S1 | `packages/contracts/src/mobileWorkspace.ts`; `apps/desktop/src/mobile/dev/workspace/{index,preload}.ts`; `apps/desktop/src/mobile-tool/dev/workspace.ts`; `apps/web/src/mobile/dev/workspace/{bridge.ts,WorkspaceBanner.tsx,WorkspaceProjectGroup.tsx,WorktreesSettingGroup.tsx}` |
| S2 | `packages/contracts/src/{mobileDoctor,mobilePackages}.ts`; `apps/desktop/src/mobile/dev/doctor/{index,preload,facts}.ts`; `apps/desktop/src/mobile/dev/packages/{index,preload}.ts`; `apps/desktop/src/mobile-tool/dev/{doctor,packages}.ts`; `apps/web/src/mobile/dev/doctor/{bridge.ts,DoctorGroup.tsx}`; `apps/web/src/mobile/dev/packages/{bridge.ts,PackagesGroup.tsx}` |
| S3 | `packages/contracts/src/mobileLogs.ts`; `apps/desktop/src/mobile/dev/crash/{index,preload}.ts`; `apps/desktop/src/mobile/dev/build/{index,preload}.ts`; `apps/desktop/src/mobile-tool/dev/{crash,build}.ts`; `apps/web/src/mobile/dev/crash/{bridge.ts,CrashBanner.tsx,CrashWatchSettingGroup.tsx}`; `apps/web/src/mobile/dev/build/{bridge.ts,BuildGroup.tsx}` |

Stylesheets follow the same rule: S0 creates `dev/dev.css`, `dev/workspace/workspace.css`, `dev/doctor/doctor.css`, and `dev/crash/crash.css`, empty, and imports them once. Each stream writes only its own file.

### How S0 was built, where it differs from section 4

S0 is built. These are the differences from section 4 that the streams code against. The ownership tables above still hold.

- **`mobile_propose` takes `folder`, not `cwd`.** `cwd` already carries the agent's own folder, which ZLI uses to find its worktree, so the command's folder (relative to the worktree, "." by default) is `folder`. The stored proposal action still calls it `cwd`.
- **Each tool stub exports one object.** `mobile-tool/dev/<feature>.ts` exports `<feature>Tools: MobileDevToolModule` (`{ tools, format?, instructions }`, type in `mobile-tool/dev/types.ts`), for example `workspaceTools`. Replace the object, keep the name.
- **Channel names are enforced.** `registerMobileIpc` throws at startup for a dev channel that does not match `zli:mobile:<feature>:<verb>` (lowercase, verb may have dashes). `composeMobileDev` throws when two features register the same action, channel, or test operation.
- **Extra S0 files.** S0 owns these, and streams use them without editing them:
  - Contracts: `mobileDev.ts` also has `MobileProposalList`, `MobileTestInput`, and the e2e inputs `MobileTestProposeInput`, `MobileTestProposeFileInput`, `MobileTestRunnerAnswer`, and `MobileTestFetchAnswer`.
  - Desktop: `mobile/dev/proposalActions.ts` (the proposals feature), `mobile/dev/preloadIpc.ts` (`PreloadIpc` and `listenParsed` for preload stubs), `mobile/dev/proposalPreload.ts`, `mobile/dev/testHost.ts` (`createTestDevHost`, an in-memory host for unit tests), `mobileDevApi.ts`, `mobile/testing/fakeMobileService.ts`, and `mobile-tool/devTools.ts`.
  - Web: `mobile/dev/context.ts` (`MobileDevContext`, which also has `onOpenTerminal`), `mobile/dev/styles.ts` (imports the four stylesheets), `MobileDevSettingGroups.tsx`, and `sendToAgent.ts` (`sendToWorktreeAgent` sends when the agent is idle and queues the message when it is busy).
- **e2e test operations.** A mock launch with `ZLI_TEST_MOBILE=fake` exposes `window.zli.test.mobile(op, input)`. S0's operations: `propose` and `propose-file` (both use the first ready worktree when `worktreeId` is left out), `runner-answer` `{ match, answer: { code, stdout, stderr, timedOut } }` (the newest answer whose `match` is in the command line wins; with none, the fake runner answers exit 0 and no output), and `fetch-answer` `{ url, status, json }` (unanswered URLs get 404). A stream adds operations in its own feature's `testOps`, and its specs reuse the helpers in `tests/e2e/mobile.spec.ts` by copying them.

### Streams

**S0: Scaffold, proposals, and e2e fake (do first, alone).**
- All of section 4. It must leave `npm run verify` green, with every stub returning empty, and `tests/e2e/mobile.spec.ts` passing.
- Estimated at one agent session.
- When it is done, the orchestrator commits it to `feat/mobile-ai-dev`, and S1-S3 branch from that commit.

**S1: Isolation (F1).**
- Its own files: the S1 stubs and `apps/desktop/src/mobile/dev/workspace/{portOwner,projectInfo}.ts`.
- It also edits these existing files, which no other stream touches:
  - Server: `apps/server/src/daemon-entry.ts`, `apps/server/src/terminal/TerminalReactor.ts`, `apps/server/src/providers/registerProviders.ts`, `apps/server/src/providers/AcpProviderAdapter.ts`, and the new `apps/server/src/mobile/metroEnv.ts`.
  - Desktop: `MobileControlActions.ts` (the `mobileboot` and `mobileopenurl` cases), `DeviceManager.ts` (`boot` and `openUrl`), the `boot` options type in `MobileDriver.ts`, `AndroidDriver.ts` (`boot`), `IosSimulatorDriver.ts` (accept and ignore `preferredPort`), and `adb.ts`.
  - Web: `apps/web/src/mobile/ExpoBanner.tsx` and `apps/web/src/mobile/mobile.ts`.
  - Their tests.
  - e2e: `tests/e2e/mobile-workspace.spec.ts`.

**S2: Doctor and package guard (F2, F3).**
- Its own files: the S2 stubs, everything under `apps/desktop/src/mobile/dev/{doctor,packages}/`, and fixtures.
- It edits no existing files outside its stubs.
- e2e: `tests/e2e/mobile-doctor.spec.ts`.

**S3: Crash watch and build brief (F4, F5).**
- Its own files: the S3 stubs and everything under `apps/desktop/src/mobile/dev/{crash,build}/`.
- It also edits, and no other stream touches: `MobileDriver.ts` (the **new `streamLogs` method appended at the end of the interface**; S1 only changes the `boot` options type near the top), `AndroidDriver.ts` (**a new method appended at the end of the class**; S1 edits only `boot`), `IosSimulatorDriver.ts` (a method appended at the end of the class), `FakeDriver.ts`, and `apps/web/src/mobile/MobileLogsDrawer.tsx`.
- e2e: `tests/e2e/mobile-crash.spec.ts` and `tests/e2e/mobile-build.spec.ts`.
- It reads S2's `projectFacts` only through the S0 stub `dev/doctor/facts.ts`, so it never imports unmerged S2 code.

**Known near-overlap:** S1 and S3 both touch `MobileDriver.ts`, `AndroidDriver.ts`, and `IosSimulatorDriver.ts`. S1 edits the `boot` method, and S3 appends at the end of the file. Those hunks are far apart, so Git merges them cleanly. If a conflict appears, keep both sides.

### Merge order

1. **S0** into `feat/mobile-ai-dev`, before the others start.
2. **S1**. It touches the server and the device layer, and is the widest change. Rebase S2 and S3 after it, and run `npm run verify`.
3. **S2**. After it, F5 briefs pick up real version findings with no code change, because `facts.ts` now has content.
4. **S3**. Rebase, then run the full verify, `npm run build`, and every `tests/e2e/mobile*.spec.ts`. Then the final full e2e suite.

After S2 merged, a cleanup commit made S1's `projectInfo.ts` use S2's `findAppDir` from `readProject.ts`, so the workspace and the doctor always pick the same app folder. After S3 merges, `BuildGroup` reuses S2's `FindingRow` from `DoctorGroup.tsx`.

### Hand-back checklist for every stream

- [ ] It edits only the files listed for the stream (check with `git diff --stat` against the S0 commit).
- [ ] Every new probe uses `host.runner` and `host.env`. No `process.env` spread in new code.
- [ ] Every generated command or file write goes through `host.proposals.create`. No direct `runner.run` of an install, fix, or build.
- [ ] Copy in the UI matches this spec, or the change is noted in the hand-back.
- [ ] `npm run verify` passes. The stream's e2e spec passes under `xvfb-run -a` after `npm run build`.
- [ ] Hardware-only behavior (real adb, simulator) is added to `apps/web/src/mobile/MANUAL_TEST.md` under a new heading for the feature.
