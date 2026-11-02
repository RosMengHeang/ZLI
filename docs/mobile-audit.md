# ZLI Mobile audit (Phase 1)

Branch `feat/mobile-ai-dev`, HEAD `2ea5359` (v0.1.14). All paths are relative to `v2/` unless they start with `/` or the repo root files (`AGENTS.md`, `DESIGN.md`, `README.md`). Line numbers are from this checkout.

## TL;DR

- Mobile is a **desktop-main-process feature**, not a runtime-server feature. Device drivers, leases, streaming, the Android SDK installer, and the agent tool's action handlers all live in `apps/desktop/src/mobile/`. The server only hands the `zli-mobile` MCP server spec and PATH shim to agents.
- Two front doors share one `DeviceManager`:
  1. **Person**: renderer → preload `bridge.mobile.*` → `ipcMain` `zli:mobile:*` channels → `mobileIpcHandlers` → `MobileService`.
  2. **Agent**: `zli-mobile` MCP server or CLI (child of the agent) → HTTP `BrowserControlServer` (bearer token from the control file) → `createMobileControlActions` → `DeviceManager`.
- To add an agent capability, touch contracts (`MOBILE_CONTROL_ACTIONS` and an input schema), the driver interface, `MobileControlActions.run`, `MOBILE_MCP_TOOLS`, and the CLI. No per-agent config is needed.
- To add a person-facing capability, touch contracts, `mobileIpc.ts`, `preloadApi.ts` `createMobileApi`, `MobileBridge` in `apps/web/src/runtime/bridge.ts`, and then the UI in `apps/web/src/mobile/*` or `apps/web/src/settings/MobileSection.tsx`.
- **Verify passes on a clean checkout once pnpm is pinned to 10.34.9.** It takes 171 s: 250 test files and 2,380 tests pass, with 1 file and 31 tests skipped. Out of the box, `npm run verify` fails in 1 s with `ERR_PNPM_BAD_PM_VERSION`. See "Verify and e2e status".
- **e2e runs here** under `xvfb-run -a` after `npm run build`. `settings.spec.ts` passed 3/3 in 36 s. There is **no mobile e2e coverage today**, and no test hook to inject a fake driver into the packaged app.

---

## 1. File map

### Contracts (`packages/contracts/src/mobile.ts`, 450 lines; tests in `mobile.test.ts`)

| Lines | What |
|---|---|
| 5-39 | `MobilePlatform`, `MobileDeviceKind`, `MobileDeviceState`, `MobileLease`, and `MobileDevice`. Device ids are `android-avd:<name>`, `android:<serial>`, or `ios:<udid>`. |
| 41-87 | Setup status: `MobileToolProbe`, `MobileHost`, `MobileAndroidStatus` (sdkRoot, adb/emulator/sdkmanager/avdmanager/java probes, acceleration, `missing[]`), `MobileIosStatus` (simctl, idb), and `MobileSetupStatus`. |
| 89-129 | Android setup plan, licenses, run input, and progress. |
| 131-180 | AVD names, system image and profile ids, list, create, and delete. |
| 182-185 | **`MobileSettings = { agentTools: boolean }`** and `DEFAULT_MOBILE_SETTINGS`. This is the only persisted mobile setting today. |
| 190-220 | `MobileButton` enum, and `MobilePanelInput` (touch, text, button, rotate). |
| 222-268 | Stream protocol (`MobileStreamInfo`, `MobileStreamEvent`: info, config, frame as H.264 Annex B, still as base64 PNG, ended) and `MobileScreenshot`. |
| 270-291 | Reveal event and pop-out window schemas. |
| 293-313 | **`MOBILE_CONTROL_ACTIONS`**, the agent action names (lowercase letters only, because they become HTTP routes). |
| 315-410 | Agent tool inputs (`MobileControl*Input`). Each extends `MobileControlTarget` (`worktreeId`, `defaultWorktreeId`, `cwd`) with an optional `deviceId`. |
| 412-436 | Panel inputs for open-url, launch, and logs. |
| 437-450 | `MobileUiNode` (ref, role, text, label, id, bounds, flags). |

### Desktop main process (`apps/desktop/src/mobile/`)

| File | Role |
|---|---|
| `MobileService.ts` 1-207 | `createMobileService()` wires everything together and has no Electron dependency. Tool detection is cached for 3 s on Android and 30 s on iOS (lines 92-138). It downloads and verifies the scrcpy server (140-157), and builds `DeviceManager`, `AndroidSetup`, and `AvdManager`. iOS tool detection is `detectIosTools` (44-81), with Homebrew and pip search dirs at 38-42. |
| `MobileDriver.ts` 1-50 | **The `MobileDriver` interface**: list, boot, shutdown, install, launch, openUrl, snapshot, tap, swipe, type, press, rotate, screenshot, logs, screenSize, dispose. Also defines `MobileDriverError(message, status)`. |
| `AndroidDriver.ts` 73-400 | adb and emulator driver. install requires an `.apk` and runs `adb install -r -t` (213-218). launch uses `monkey` or `am start -n` (220-231). openUrl runs `adb reverse` for localhost and `exp://`, then `am start VIEW` (233-239). snapshot runs `uiautomator dump` with 3 retries (241-257). tap, swipe, type, and press use `input` (259-285). rotate uses `settings put system user_rotation` (287-296). screenshot uses `exec-out screencap` (298-313). logs runs `logcat -d`, filtered by `pidof <appId>` (315-324). `connection()` at 340 is used for scrcpy. |
| `IosSimulatorDriver.ts` 221-478 | Uses simctl for lifecycle, install, launch, openurl, screenshot, and logs. Uses idb for describe (UI tree), tap, swipe, and text. Rotation goes through an AppleScript (`SIMULATOR_ROTATE_SCRIPT`, 167). |
| `IosVideoSource.ts` | Live video from `idb video-stream`. **Off unless `ZLI_MOBILE_IOS_VIDEO=1`** (190-193). The TODO at 134-137 says this is unverified on a Mac. |
| `DeviceManager.ts` 83-570 | Shared device list (`list()` coalesces concurrent calls, 107-119), boot and shutdown with cancel (131-165), `takeOver` and `release`, `acquireForAgent` (167-177), per-viewer streams with scrcpy video or polled stills (189-280, 347+), `panelInput`, which agent leases block (283-311), and panel openUrl, launch, and logs (314-339). `PERSON` lease owner is at 542, and `scrcpyMessagesFor` at 545. |
| `DeviceLeases.ts` | One driver per device. An agent's lease is 5 min and renews on every action (`DEFAULT_AGENT_LEASE_MS`, line 3). A person's lease outranks agents' leases and never expires. |
| `MobileControlActions.ts` 1-348 | **The agent action handler.** The owner is `agent:<worktreeId>` (69-73). `pickDevice` defaults to the last-used device, then a free online one, then any free virtual one (75-105). Each action acquires the lease (107-115). The `agentTools` gate is at 145-147. Per-action logic is the `switch` at 148-314. Snapshot refs are stored per device and owner (136-143, 222-236). `mobile_boot` waits up to 140 s, then returns `booting: true` (168-193). |
| `mobileIpc.ts` 1-133 | **Renderer IPC handlers** for every `zli:mobile:*` channel, with zod-parsed inputs (55-132). The stream viewer is `window-<webContentsId>`. |
| `MobileSettingsStore.ts` 1-38 | JSON file store for `MobileSettings` (`get`/`set`). |
| `AndroidSdk.ts`, `AndroidSetup.ts`, `AndroidRepository.ts`, `AvdManager.ts`, `download.ts`, `unzip.ts` | SDK detection (env, default locations, or ZLI's own copy), the guided SDK, JDK, and system image install with license acceptance, the AVD list, create, and delete, and verified downloads. `sdkToolEnv` (`AndroidSetup.ts:65-78`) adds `ANDROID_HOME`, `ANDROID_SDK_ROOT`, and `JAVA_HOME` to the base env. |
| `adb.ts` | adb output parsers, `localhostPort` (`exp:` maps to 8081, line 146-147), and `inputTextArgument`. |
| `uiTree.ts` | uiautomator and idb tree, formatted for agents with `eN` refs (`formatUiTree`, `centerOf`). |
| `scrcpy/protocol.ts`, `scrcpy/ScrcpySession.ts` | scrcpy server protocol: version, URL, and SHA-256 pinned, video plus control messages. |
| `PopOutWindows.ts` | One device per BrowserWindow. Pinned windows stay on top, and the aspect ratio is locked. |
| `ProcessRunner.ts` | `spawn` wrapper. **The env defaults to `process.env` of the desktop main process** (lines 107-109, 164-166). |
| `host.ts` | OS and arch detection, `findOnPath`, and an fs abstraction. |
| `FakeDriver.ts`, `FakeProcessRunner.ts` | Test doubles used by the unit tests. |

### Desktop wiring (`apps/desktop/src/main.ts`)

| Lines | What |
|---|---|
| 64-69 | Mobile imports. |
| 122-123 | Module-level `mobile` and `mobileSettings`. |
| 211-221 | `PopOutWindows` (file `mobile-popouts.json`). |
| 330-343 | `BrowserToolPaths`: control file, `zli-mobile.js` script, and shim dir. Test launches keep these beside `ZLI_DATABASE_PATH`. |
| 357-374 | `MobileSettingsStore` (`mobile-settings.json`, or `${db}.mobile-settings.json` in tests), and `createMobileService({ env: process.env, mobileDir: <defaultUserData>/mobile })`. **Test launches share the real SDK folder.** |
| 376-382 | `createMobileControlActions` with `reveal` mapped to `zli:mobile:reveal`. |
| 414-422 | `BrowserControlServer` dispatch to agent, mobile, or browser actions. |
| 653, 701-709 | `registerMobileIpc()`: every handler goes on `ipcMain.handle` with the viewer id. |
| 725-728 | `sendToMobileWindows`: device and stream events go to the main window and pop-outs. |
| 845-849 | Shutdown: pop-outs first, then `mobile.dispose()`. |

### Agent tool (`apps/desktop/src/mobile-tool/`)

| File | What |
|---|---|
| `mcp.ts` 10-11 | `PANEL` blurb, used in the tool descriptions and the server `instructions`. |
| `mcp.ts` 20-170 | **`MOBILE_MCP_TOOLS`**: `mobile_devices`, `mobile_boot`, `mobile_shutdown`, `mobile_install`, `mobile_launch`, `mobile_open_url`, `mobile_snapshot`, `mobile_tap`, `mobile_swipe`, `mobile_type`, `mobile_press`, `mobile_rotate`, `mobile_screenshot`, `mobile_logs`, `mobile_release`. |
| `mcp.ts` 172-195 | Common `cwd` and `deviceId` properties. `mobileToolInput` resolves a relative install path against the agent's cwd. |
| `mcp.ts` 197-224 | `formatMobileResult`: the screenshot becomes an image block, the snapshot becomes a header plus tree, logs become text. |
| `mcp.ts` 226-241 | `createMobileMcpServer`: `instructions` string at 230. `visibleTools` hides every tool when `mobileaccess` returns `enabled: false`. |
| `cli.ts` 6-30, 57-227 | `ZLI_MOBILE_HELP`, `parseMobileArgs`, `runMobileCli`: the same actions as a shell command. |
| `zli-mobile.ts` | Entry point: `mcp` subcommand or CLI. Bundled to `apps/desktop/dist/zli-mobile.js`. |
| `../browser-tool/client.ts` 47-61 | Reads the control file (port and bearer token) named by `ZLI_BROWSER_CONTROL_FILE`, and fills in `defaultWorktreeId` from `ZLI_WORKTREE_ID`. |
| `../browser/BrowserControlServer.ts` | Loopback HTTP server. The bearer token is random per run and written to the endpoint file, which only the current user can read (lines 14-35, 63, 88, 110). |

### Renderer (`apps/web/src/`)

| File | What |
|---|---|
| `settings/SettingsDialog.tsx` 60-121 | Section registry: `SectionEntry {id,label,icon,group,keywords}`. The Mobile entry is at **100-106**, in the Tools group, with keywords "phone android emulator iphone simulator device frame sdk avd". Search is at 115-121, the body switch at **311**, and the import at 38. |
| `settings/MobileSection.tsx` 1-358 | **Settings > Mobile.** `SectionHeader` is at 34-37. `MobileSettingsBody` (49+) contains these groups: **Devices** (112-157, with Boot and Shut down per row), **Screen** (159-166, "Show device frame"), **Agents** (168-179, "Let agents use devices", which is `agentTools`), **Android SDK** (181-198, `AndroidRows`, `ToolRow`, Check again), and **iPhone simulator** (200+). Tests are in `MobileSection.test.tsx`. |
| `mobile/MobilePane.tsx` 1-645 | The Mobile side panel. `MobilePane` (49) receives `devServers` for Expo. The setup and empty states are `MobileSetup` and `VirtualDevices`. The ready view (~472+) is: `PaneHeader` with actions, then `MobileToolbar` (515), `LeaseBanner` (551), `ExpoBanner` (563-570), the device (`DeviceFrame` and `DeviceScreen`), `MobileControls` (596), `MobileLogsDrawer` (613), and the agent-tools `Switch` (623). |
| `mobile/mobile.ts` 1-395 | Pure helpers: `errorText`, notices, `urlToOpen`. `expoServer()` and `expoUrl()` are at **278-297**; detection uses ports 8081, 19000, and 19006 or a terminal name matching /expo\|metro/. |
| `mobile/ExpoBanner.tsx` | "Expo is running on localhost:PORT" with an Open action. Dismissals are kept per session (`zli.mobile.expo.v1`). |
| `mobile/MobileControls.tsx`, `MobileToolbar.tsx` | Bottom bar (Type text, Open URL, Back/Home/Recents, Rotate, Screenshot, More) and toolbar (device picker, Shut down, pop-out). |
| `mobile/DeviceScreen.tsx` (510), `DeviceFrame.tsx`, `deviceSkin.ts` | WebCodecs H.264 decode or stills, pointer-to-device coordinates, and the device skin. |
| `mobile/MobileLogsDrawer.tsx` | Logs drawer: app id filter, text filter, line count. |
| `mobile/MobileDeviceWindow.tsx` | Pop-out window renderer. |
| `mobile/useMobileSettings.ts` 14-51 | Shared hook for `getSettings` and `setSettings`, used by Settings > Mobile, the panel, and `settings/McpServersSection.tsx` `ZliMobileRow` (637-661, the zli-mobile row in Integrations' MCP list). |
| `mobile/useDeviceFrame.ts`, `useDeviceZoom.ts` | localStorage-backed UI preferences. |
| `runtime/bridge.ts` 81, 137+ | `mobile?: MobileBridge` and the `MobileBridge` type. |
| `shell/AppShell.tsx` | Import (34), reveal and pop-out state (222-224), `mobileAvailable` and `onReveal` (444-452), Expo dev servers (460), the `toggleMobile` handler (570-571), palette entries "Focus mobile" and "Pop out mobile device" (1794-1813), the Topbar prop (2033), and the pane render (2215-2220). |
| `shell/keybindings.ts:17`, `settings/appSettings.ts:36,84` | `toggleMobile` = Mod+Shift+M. |
| `shell/Topbar.tsx` | `SidePane "mobile"` toggle, shown only when `mobileAvailable`. |
| `workspace/PanelResizer.tsx:4` | `PanelId` includes `"mobile"`. |

### Preload (`apps/desktop/src/preloadApi.ts`)

`createMobileApi` (68-148) maps one method to each channel, and every result is zod-parsed. The methods are status, setupPlan, setupProgress, runSetup, cancelSetup, onSetupProgress, listAvds, createAvd, deleteAvd, devices, onDevices, boot, shutdown, startStream, stopStream, onStream, input, openUrl, logs, launch, takeOver, release, screenshot, getSettings, setSettings, onReveal, popOuts, onPopOuts, popOut, closePopOut, pin, and aspect. Tests are in `apps/desktop/src/preload.test.ts` (around 400-415).

### Server-side touch points (mobile only as the agent tool)

- `apps/server/src/browser-tool/browserTool.ts`: `MOBILE_MCP_SERVER = "zli-mobile"` (10), `browserToolConfigFromEnv` (66-86), `mobileMcpServerSpec` (107-111), and **`zliMcpServerSpecs`** (113-117), which returns zli-browser, zli, and zli-mobile.
- `apps/server/src/devservers/devServerDetector.ts:8-14`: detects `exp://localhost` and `127.0.0.1`. LAN `exp://192.168…` is deliberately not detected (test at `devServerDetector.test.ts:38`).

---

## 2. How agents, worktrees, and terminals are spawned, and how env is passed

Process chain: **Electron main** → (`EnvironmentProcess.defaultLauncher`) **runtime server** → (`DaemonSupervisor`) **terminal daemon** → (node-pty) **agent CLI, shell, or setup command** → the agent's own children (**`zli-mobile mcp`**, git hooks, build tools).

| Step | Where | Env |
|---|---|---|
| Desktop → server | `apps/desktop/src/runtime/EnvironmentProcess.ts:133-150` | `{...process.env, ...extraEnv, ZLI_DATABASE_PATH, ZLI_RUNTIME_TOKEN, ZLI_RUNTIME_STOP_ON_STDIN_END}`. The token is generated in the same file (`randomBytes(32)`, line 37), **so the desktop's own `process.env` never contains it**. `extraEnv` holds the browser tool vars from `browserToolEnvironment` (`apps/desktop/src/browser/BrowserToolShim.ts:21-31`): `ZLI_BROWSER_CONTROL_FILE`, `ZLI_BROWSER_TOOL_COMMAND`, `ZLI_BROWSER_TOOL_SCRIPT`, `ZLI_AGENT_TOOL_SCRIPT`, `ZLI_MOBILE_TOOL_SCRIPT`, `ZLI_CONNECT_TOOL_SCRIPT`, and `ZLI_BROWSER_SHIM_DIR`. |
| Server start | `apps/server/src/main.ts:405-418` `takeLaunchOptions` | Reads the token and runs **`delete env.ZLI_RUNTIME_TOKEN`** (407) on `process.env` before anything spawns. |
| Server → daemon | `apps/server/src/daemon/DaemonSupervisor.ts:230-238` (desktop variant `apps/desktop/src/runtime/DesktopDaemon.ts:41-44`) | `{...process.env, ZLI_DAEMON_ENDPOINT_PATH, ZLI_DAEMON_PROTOCOL_VERSION, ZLI_DAEMON_VERSION, ZLI_DAEMON_TOKEN}` |
| Daemon → PTY | `apps/server/src/terminal/NodePtyFactory.ts:72-84` `childPtyEnv` | `{...source, ...overrides}` with the shim dir prepended to PATH. **Deletes `ZLI_DAEMON_TOKEN`, `ZLI_DAEMON_ENDPOINT_PATH`, and `ZLI_RUNTIME_TOKEN`** (80-82). |
| Override allowlist | `apps/server/src/daemon-entry.ts:215-245` `ENV_OVERRIDE_RULES` and `readEnvOverrides` | Only `TERM`, `COLORTERM`, `ZLI_WORKTREE_ID` (must match the worktree), `ZLI_BROWSER_CONTROL_FILE` (an absolute path), and `OPENCODE_CONFIG_CONTENT` (a JSON object) are allowed. Any other key throws `Terminal environment override is not allowed`. |
| Agent env | `browserTool.ts:149-171` `browserToolEnv` and `agentEnv` | Adds `ZLI_BROWSER_CONTROL_FILE` and `ZLI_WORKTREE_ID`, and puts the shim dir first on PATH (helpers at 123-146). |
| Launch args | `apps/server/src/terminal/agentLaunch.ts:58-156` (`buildAgentArgs`, `agentModeEnv`, `mcpLaunchArgs`); merging in `TerminalReactor.ts:245-254` | MCP flags per provider; see section 3. |
| Other server spawns | `AcpProviderAdapter.ts:88`, `mcp/spawnServer.ts:42`, `git/GitProcess.ts:74`, `review/PullRequestService.ts:1362`, `TerminalReactor.ts:294`, `registerProviders.ts:168`, `main.ts:278` | All use `{...process.env, ...}` and rely on the startup delete. |
| **Mobile spawns** (adb, emulator, simctl, idb, sdkmanager) | `apps/desktop/src/mobile/ProcessRunner.ts:107-109,164-166`; env from `sdkToolEnv(options.env, …)` (`AndroidSetup.ts:65-78`) with `options.env = process.env` (`main.ts:364`) | These run in the **desktop main process**, which never holds `ZLI_RUNTIME_TOKEN`. In e2e and test launches, its env carries `ZLI_TEST_*` and `ZLI_DATABASE_PATH`, which is harmless. |

The runtime-token fix (commit `4428cd7`, PR #114) shipped in **v0.1.14**. The release notes say: "ZLI's runtime used to pass its private access token on to every program it started, including agent CLIs, git hooks, MCP servers, and dev scripts … The runtime now removes the token as soon as it reads it, so nothing it starts can see it." The tests are `apps/server/src/main.test.ts:9-30`, `apps/server/src/terminal/NodePtyFactory.test.ts:237-253`, and `tests/e2e/runtime-token.spec.ts:14-39`. The e2e test installs a post-checkout hook that dumps `env`, then asserts `ZLI_DATABASE_PATH` is present and `ZLI_RUNTIME_TOKEN` is absent.

**Worktrees:** `apps/server/src/worktrees/WorktreeReactor.ts:60-87` handles events, and `WorktreeService.ts` runs git through `GitProcess` with the server env. `WorktreeSetup.ts:41-62` copies `zli.json` `worktree.copy` entries, then runs `worktree.setup` commands one per visible terminal (`bash -lc`, or `cmd.exe /d /s /c` on Windows) after the person approves them. `zliConfig.ts` parses `zli.json` and is the natural home for per-project mobile config, such as an app id or build command.

### Rules for feature builders (spawning and env)

1. Never read, store, or re-add `ZLI_RUNTIME_TOKEN` or `ZLI_DAEMON_TOKEN`. Server spawns inherit `process.env` and rely on the delete in `takeLaunchOptions`. There is **no general safe-spawn helper or allowlist**. Do not introduce env copying that runs before `takeLaunchOptions`.
2. A new env var that must reach agent PTYs has to be added to `ENV_OVERRIDE_RULES` (`daemon-entry.ts:215`) with a narrow validator, or the daemon rejects the launch.
3. Pass tool access as **a file path, not a secret**. Use the `ZLI_BROWSER_CONTROL_FILE` plus `ZLI_WORKTREE_ID` pattern. Do not invent a new token env var for the mobile tool.
4. Mobile child processes (adb and so on) go through `ProcessRunner` with `tools.env` (`sdkToolEnv`), so they stay testable with `FakeProcessRunner`.
5. When adding spawn paths, extend `runtime-token.spec.ts`, `main.test.ts`, and `NodePtyFactory.test.ts`.

---

## 3. How MCP servers, skills, and instructions reach agents

After commit `47d55df` ("Give MCP servers and skills only to the agents ZLI starts", #120, shipped in v0.1.14), ZLI no longer writes anything into home-folder agent settings. Everything goes per launch or per worktree.

| Agent | Mechanism | Where |
|---|---|---|
| Claude Code | `--mcp-config <file>`, per-worktree JSON (`claude-<wt>.json`). The flag is variadic, so it must stay last. | `browserTool.ts:195-205`; `agentLaunch.ts:139-150` |
| Copilot | `--additional-mcp-config @file` | `browserTool.ts:208`; `agentLaunch.ts:151-152` |
| Codex | `-c mcp_servers.X.*` flags; per-thread config for app-server threads | `browserTool.ts:239-271`; `providers/registerProviders.ts:193-204` |
| OpenCode | `OPENCODE_CONFIG_CONTENT`, merged with the user's value | `browserTool.ts:274-298`; `agentLaunch.ts:238` |
| Goose | `--with-extension` | `browserTool.ts:304-320` |
| Cursor, Droid, Kimi, Gemini, Qwen | Project MCP file in the worktree (`.cursor/mcp.json`, `.factory/mcp.json`, `.kimi-code/mcp.json`, `.gemini/settings.json`, `.qwen/settings.json`). Cursor also gets `--approve-mcps` when the file is ZLI's. | `browser-tool/mcpSettingsFiles.ts:19-35,64-80`; `agentLaunch.ts:153-156` |
| ACP agents | `acpMcpServer` entries | `browserTool.ts:173-188`; `providers/AcpProviderAdapter.ts:93` |
| Accounts | Per-account settings file, synced by `syncAccountMcpServers` | `mcpSettingsFiles.ts:186-221` |

- **Server list:** `TerminalReactor.ts:254` builds `[...zliMcpServerSpecs(browserTool, worktreeId), ...userAdded]`. Each ZLI spec runs `electron` with `ELECTRON_RUN_AS_NODE=1`, args `[script, "mcp"]`, and env `{ZLI_BROWSER_CONTROL_FILE, ZLI_WORKTREE_ID}` only (`browserTool.ts:89-117`).
- **Worktree file bookkeeping:** `apps/server/src/worktrees/WorktreeAgentFiles.ts` (class at 33+). It only writes files that are absent or unchanged since ZLI wrote them, records digests in `worktree-files.json`, and hides the paths in `.git/info/exclude` between `# zli:start` and `# zli:end` (9-11, `withExcludeLines` 289-303). Everything is removed on quit, or on the next start after a crash.
- **Skills:** `skills/SkillStore.ts:41` calls `syncSkillCopies` (`skills/skillCopies.ts:74`, wired at `apps/server/src/main.ts:206`). This copies skills into each worktree's `.agents/skills` (`SHARED_SKILLS_DIR`, line 11) and `.claude/skills` (`worktreeSkillDirs` 46-56). Size limits are in `skillFolders.ts:10-12`.
- **AGENTS.md and CLAUDE.md:** ZLI **does not write any instruction block** into AGENTS.md or CLAUDE.md. Mobile guidance reaches agents only through the MCP `instructions` string (`mcp.ts:230`), the tool descriptions (`mcp.ts:20-170`), and `zli-mobile --help` (`cli.ts:6-30`). Inserting a block into an existing AGENTS.md would need new merge code, because `WorktreeAgentFiles` refuses to touch a user-owned file. The safer channel is a **ZLI-shipped skill** via `syncSkillCopies`, or a richer MCP `instructions` string.

---

## 4. Extension points for new Mobile features

**A. A new agent tool, such as wait-for-element, clear app data, grant permission, set location, crash report, or build and install**
1. `packages/contracts/src/mobile.ts`: add the action to `MOBILE_CONTROL_ACTIONS` (293-311) and add a `MobileControl…Input` schema extending `MobileControlDeviceInput`.
2. `apps/desktop/src/mobile/MobileDriver.ts`: add the method to `MobileDriver`, then implement it in `AndroidDriver.ts`, `IosSimulatorDriver.ts`, and `FakeDriver.ts`. For a cross-cutting helper that is not per platform, implement it in `MobileControlActions` on top of existing driver calls.
3. `apps/desktop/src/mobile/MobileControlActions.ts`: add a `case` in `run` (148-314). The `agentTools` gate (145-147) and leasing (`online()`, 117-124) come for free.
4. `apps/desktop/src/mobile-tool/mcp.ts`: add an entry to `MOBILE_MCP_TOOLS`, plus custom formatting in `formatMobileResult` if needed. Update the `instructions` string at 230.
5. `apps/desktop/src/mobile-tool/cli.ts`: add the subcommand and help text.
6. Tests: `MobileControlActions.test.ts`, `zli-mobile.test.ts`, the driver tests with `FakeProcessRunner`, and `packages/contracts/src/mobile.test.ts`.

No per-agent config changes are needed, because every ZLI agent already gets `zli-mobile`.

**B. A new panel or settings capability**
1. Add the contract schema.
2. Add a handler in `apps/desktop/src/mobile/mobileIpc.ts` and a test in `mobileIpc.test.ts`.
3. Add a method in `apps/desktop/src/preloadApi.ts` `createMobileApi` and a test in `preload.test.ts`.
4. Add the type to `MobileBridge` in `apps/web/src/runtime/bridge.ts`.
5. Build the UI. Settings rows go in a new `SettingGroup` in `MobileSection.tsx` (next to 159-179); add search words to `SettingsDialog.tsx:105`. Panel features go in `MobilePane.tsx` around 515-623: banners beside `LeaseBanner` and `ExpoBanner`, and actions in `MobileControls.tsx` or `MobileToolbar.tsx`.
6. Update the fake bridge in `MobilePane.test.tsx` and `MobileSection.test.tsx`.

**C. A new persisted mobile setting**

Extend `MobileSettings` and `DEFAULT_MOBILE_SETTINGS` (`mobile.ts:182-185`). `MobileSettingsStore` and `settings-get`/`settings-set` already pass partial patches through, so expose the setting via `useMobileSettings.ts`. For a renderer-only preference, use localStorage the way `useDeviceFrame.ts` does.

**D. Agent instructions and skills**

Ship a skill through `SkillStore` and `syncSkillCopies`, or extend the MCP `instructions` and `PANEL` text in `mcp.ts`.

**E. Per-project mobile config**

Add a `mobile` block to `zli.json` (`apps/server/src/worktrees/zliConfig.ts` and `packages/contracts/src/projectConfig.ts`), for example an app id, build command, or preferred device. It would need to reach the desktop, because the mobile service has no server access today. The mobile actions only see `runtime.projection().worktrees`.

**F. Dev-server and Metro awareness**

`devServerDetector.ts` on the server, `expoServer` in `mobile.ts:278-297`, the AppShell dev-server feed (`AppShell.tsx:460`), and `ExpoBanner.tsx`.

**G. A new e2e test**

`tests/e2e/desktop-fixtures.ts` provides `launchDesktop(repo, root, {env})` (158) and `desktopCommand` (119-156). `env` can prepend a PATH with fake `adb` or `emulator` scripts. Note that `MobileService` finds adb through the SDK layout and `ANDROID_HOME`, not only PATH, so a fake SDK dir with `ANDROID_HOME` is the realistic route. There is **no `ZLI_TEST_*` hook to inject `FakeDriver` into the app**. Adding one, for example `ZLI_TEST_MOBILE=fake` in `main.ts:361`, would be the cleanest way to get Mobile e2e coverage.

---

## 5. Known gaps, TODOs, and rough edges (from the code)

- **The agent-tools switch is in three places:** Settings > Mobile, Agents group (`MobileSection.tsx:168-179`); Settings > Integrations, in the `ZliMobileRow` of the MCP list (`McpServersSection.tsx:637-661`); and the Mobile panel (`MobilePane.tsx:623`). All three use `useMobileSettings`. `OFF_MESSAGE` (`MobileControlActions.ts:48-49`) names only the panel and Integrations, not Settings > Mobile.
- **TODO** `IosVideoSource.ts:134-137`: iOS live video is unverified and off by default (`ZLI_MOBILE_IOS_VIDEO=1`). iOS shows polled screenshots, about 1/s, faster after input.
- **No build step:** `mobile_install` takes a prebuilt `.apk` or `.app`. It hints at `./gradlew assembleDebug` (`AndroidDriver.ts:214-215`), and there is no build, run, or reinstall loop.
- **No wait or idle primitive:** agents poll `mobile_snapshot`, and uiautomator dump retries 3 times at 500 ms while the screen animates (`AndroidDriver.ts:241-257`). `mobile_boot` caps its wait at 140 s.
- **Logs are one-shot** (`logcat -d`, at most 2,000 lines). There is no streaming, no crash or ANR detection, and `appId` filtering fails when the app isn't running (`AndroidDriver.ts:315-324`). Crashes therefore vanish from the filtered view.
- **Missing device-state controls:** none for clear data or uninstall, runtime permissions, location, locale, dark mode, network conditions, push notifications, or biometric.
- **Metro and React Native:** a plain `npx react-native start` is not detected (MANUAL_TEST.md 123-124). Expo LAN URLs are deliberately ignored, and there is no reload or dev-menu trigger.
- **Device contention with parallel agents:** leases are per worktree (`agent:<worktreeId>`) and last 5 minutes. A second agent gets HTTP 423 and must pick another device or wait. There is no per-worktree emulator provisioning or queue.
- **Settings scope:** the only persisted setting is `agentTools`. There is no per-project or per-agent device policy and no default device.
- **No mobile e2e tests,** and no fake-driver injection for the packaged app. Hardware checks are manual (`apps/web/src/mobile/MANUAL_TEST.md`, 212 lines).
- **Shared SDK folder:** test launches share the real `<userData>/mobile` SDK folder (`main.ts:366-368`, intentional).

---

## 6. Conventions builders must follow

**From `/AGENTS.md`:**
- The file contains only an "antislop" block. For UI, copy, people, mobile layout, or code-comment work, load the `antislop` skill (and `antislop-ui` for UI), and *"before starting, ask the user when antislop applies: during the work, or after it is done."*
- These skills are **not installed in this environment**, so the orchestrator should decide how to honor this, for example by asking the human once for the whole workstream.

**From `/DESIGN.md` (rules relevant to Mobile):**
- Use tokens from `packages/ui/src/tokens.css`, primitives from `packages/ui/src/primitives.css`, and React primitives from `apps/web/src/ui/*` (Button, IconButton, Switch, Segmented, Badge, Field, Select, Picker, Menu, PaneHeader, EmptyState, LoadingState, StopButton). **Do not style locally:** extend the primitives instead. Feature CSS stays next to the feature (`mobile/mobile.css`, `settings/settings.css`).
- Use one accent (blue) only for primary actions, focus, and the selected agent. Green, amber, and red mean only process or Git state. Use few borders, islands on the canvas, and the 4px spacing scale. Control heights are 20, 24, 28, and 32 px.
- Settings sections are titled groups of rows: the label and description on the left, the control on the right. Switches are square and neutral. Settings > Mobile is "like an IDE's device manager": devices with state and Boot or Shut down, the device frame and agent switches, the Android SDK location and tools, and iPhone simulator support.
- The Mobile panel bottom bar has three clusters: Type text and Open URL on the left; Back, Home, and Recents centered in a well; Rotate, Screenshot, and More on the right. Shut down is a toolbar icon button. The screenshots-mode reason is a caption under the device.
- Every icon-only button has an accessible name and a tooltip that includes its shortcut. Use one stop control (`StopButton`) everywhere, including Cancel on a booting device.
- Empty states name what is missing and offer the fix. Loading states name what is loading. Errors appear next to the thing that failed.
- Motion runs 100-160 ms, with no decorative loops, and respects reduced motion.
- Copy is plain and person-facing: "the person", full sentences, and no jargon.

**Repo practice (observed):**
- Contracts are zod schemas in `packages/contracts`, and every IPC payload is re-parsed in main (`mobileIpc.ts`, see the comment at 29-31).
- Import boundaries are enforced by `scripts/enforce-boundaries.mjs` (part of verify). Formatting and lint use biome. Types use `tsc -b`.
- Unit tests use vitest with fakes (`FakeDriver`, `FakeProcessRunner`, fake bridges). Hardware-only behavior goes in `MANUAL_TEST.md`.
- Commit messages are plain-English sentences with a PR number, plus the `Co-authored-by: factory-droid[bot]` trailer.
- Releases skip pushes that only touch `docs/` or Markdown files.

---

## 7. Verify and e2e status (this machine, Linux 6.1, no display)

| Check | Result |
|---|---|
| Node | **v24.21.0**, below `engines` `>=24.22.1 <25`. pnpm prints "Unsupported engine" warnings, but nothing fails. |
| pnpm | The global `/usr/bin/pnpm` is a corepack shim whose last-known-good version was **12.14.0**. `v2/package.json` pins `pnpm@10.34.9`. |
| `npm run verify` out of the box | **Fails in 1 s**: `ERR_PNPM_BAD_PM_VERSION`. The root `package.json` has no `packageManager`, so corepack runs pnpm 12, which refuses to run in `v2/`. |
| Fix applied | `corepack install -g pnpm@10.34.9`. This only sets corepack's global default and changes no repo files. |
| Install | `cd v2 && corepack pnpm install --frozen-lockfile` took **30 s** and succeeded. It warns that build scripts were ignored for `electron-winstaller` and `esbuild`, which is harmless. |
| `npm run verify` after the fix | **PASS in 171 s**. Boundaries, format, lint, and types are clean. 250 test files passed, 1 skipped; 2,380 tests passed, 31 skipped. There are no pre-existing failures. |
| `npm run build` | **PASS in 15 s**. Vite warns that a chunk is larger than 500 kB, which is pre-existing. Build output is gitignored, so `git status` only shows `docs/`. |
| e2e, one spec | `cd v2 && ZLI_RUN_E2E=1 xvfb-run -a pnpm exec playwright test tests/e2e/settings.spec.ts` **passed 3/3 in 36 s**. The first run downloads the Electron binary. **e2e can run here; it needs `npm run build` first and `xvfb-run -a`.** |
| e2e, full suite | `cd v2 && ZLI_RUN_E2E=1 xvfb-run -a pnpm exec playwright test` **passed 61/61 in 202 s (3.3 min)**, with 2 workers and no flaky or skipped tests. |

To reproduce on this machine:

```sh
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack install -g pnpm@10.34.9          # once
cd /home/factory-user/ZLI/v2 && pnpm install --frozen-lockfile
cd /home/factory-user/ZLI && npm run verify   # ~3 min
npm run build                                 # needed before e2e
cd v2 && ZLI_RUN_E2E=1 xvfb-run -a pnpm exec playwright test   # ~3.5 min
```
