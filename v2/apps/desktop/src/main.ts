import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RuntimeClient, type RuntimeTransport } from "@zli-v2/client-runtime";
import {
  BrowserDesignCaptureInput,
  BrowserDesignMarkInput,
  BrowserFillInput,
  BrowserNavigateInput,
  BrowserPressInput,
  BrowserReloadInput,
  BrowserScreenshotInput,
  BrowserSelectorInput,
  BrowserSetBoundsInput,
  BrowserSetViewportInput,
  BrowserTabIdInput,
  BrowserWaitForNetworkIdleInput,
  type OpenInApp,
  OpenInRequest,
  RpcRequest,
  TerminalId,
} from "@zli-v2/contracts";
import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  net,
  protocol,
  screen,
  session,
  shell,
  WebContentsView,
} from "electron";
import { WebSocket } from "ws";

import {
  type AgentControlHost,
  createAgentControlActions,
  isAgentControlAction,
} from "./agents/AgentControlActions.js";
import { busyAgentCount, QuitController, quitWarning } from "./app/QuitController.js";
import { BrowserAutomation } from "./browser/BrowserAutomation.js";
import { createBrowserControlActions } from "./browser/BrowserControlActions.js";
import { BrowserControlServer } from "./browser/BrowserControlServer.js";
import { BrowserManager } from "./browser/BrowserManager.js";
import { type BrowserToolPaths, browserToolEnvironment, writeBrowserToolShims } from "./browser/BrowserToolShim.js";
import { CdpSession, type ElectronDebuggerLike } from "./browser/CdpSession.js";
import { DesignMode } from "./browser/DesignMode.js";
import {
  type CapturableWebContents,
  createCaptureFallback,
  createInputWaker,
  type WakeableWebContents,
} from "./browser/HiddenRendering.js";
import { createProjectCheckout } from "./browser/projectCheckout.js";
import { type CaptureDependencies, captureSource, listCaptureSources, parseSourceId } from "./capture/WindowCapture.js";
import { DesktopDiagnostics } from "./diagnostics/DesktopDiagnostics.js";
import { hostArch, hostOs } from "./mobile/host.js";
import { createMobileControlActions, isMobileControlAction } from "./mobile/MobileControlActions.js";
import { createMobileService, type MobileService } from "./mobile/MobileService.js";
import { MobileSettingsStore } from "./mobile/MobileSettingsStore.js";
import { mobileIpcHandlers, streamViewer } from "./mobile/mobileIpc.js";
import { PopOutWindows, type PopOutWindowLike, type WindowBounds } from "./mobile/PopOutWindows.js";
import type { AgentNotifier } from "./notifications/AgentNotifier.js";
import { registerAgentNotifications } from "./notifications/electronNotifications.js";
import { detectApps, launchApp, nodeEnvironment, type ResolvedApp } from "./openIn/OpenInApps.js";
import { ensureDesktopDaemon, shutdownDesktopDaemon } from "./runtime/DesktopDaemon.js";
import { EnvironmentProcess } from "./runtime/EnvironmentProcess.js";
import { ensureScratchFolder } from "./scratch/ScratchFolder.js";
import { shouldOpenExternal } from "./security/NavigationPolicy.js";
import { registerUpdates } from "./updates/electronUpdates.js";
import { resolveAppAsset } from "./window/ElectronProtocol.js";
import {
  applyZoomKeys,
  type BrowserWindowConstructor,
  createMainWindow,
  fitTitleBar,
  nextZoomFactor,
  type Zoom,
} from "./window/ElectronWindow.js";
import { windowsAppDetails, windowsAppId } from "./window/windowsTaskbar.js";

const DEFAULT_ENVIRONMENT_ID = "00000000-0000-4000-8000-000000000001";
const APP_ORIGIN = "zli-v2://app";
const DESKTOP_DIST = dirname(fileURLToPath(import.meta.url));

protocol.registerSchemesAsPrivileged([
  {
    scheme: "zli-v2",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

// Windows ties a window to a taskbar button when the window is created. Set any later, the window keeps
// Electron's own ID and shows as a second button with Electron's icon beside the pinned ZLI shortcut.
// Toasts also need this ID, since it matches the Start menu shortcut.
if (process.platform === "win32") app.setAppUserModelId(windowsAppId(process.execPath, app.isPackaged));

// Integration tests turn motion off so a click never lands on a dialog that is still animating in.
if (process.env.ZLI_REDUCED_MOTION === "1") app.commandLine.appendSwitch("force-prefers-reduced-motion");

let environment: EnvironmentProcess | undefined;
let runtime: RuntimeClient | undefined;
let browserManager: BrowserManager | undefined;
let browserControl: BrowserControlServer | undefined;
let mobile: MobileService | undefined;
let mobileSettings: MobileSettingsStore | undefined;
let popOuts: PopOutWindows | undefined;
let mainWindow: BrowserWindow | undefined;
let notifier: AgentNotifier | undefined;
let approvedSupportBundleRoot: string | undefined;
let scratchFolderPath: string | undefined;
let daemonEndpointPath: string | undefined;
/** Test launches record links instead of starting the system browser. */
let lastExternalUrl: string | undefined;
/** Test launches record which app a folder would open in instead of starting it. */
let lastOpenIn: { appId: string; path: string } | undefined;
let openInApps: { at: number; apps: Promise<ResolvedApp[]> } | undefined;
const openInIcons = new Map<string, Promise<string | undefined>>();
/** Apps are installed and removed while ZLI runs, so the list is looked up again after a minute. */
const OPEN_IN_TTL_MS = 60_000;

/** An icon from apps/desktop/build, which packaged builds carry next to dist. */
function appIcon(name: string): string | undefined {
  const path = resolve(DESKTOP_DIST, "..", "build", name);
  return existsSync(path) ? path : undefined;
}

async function main(): Promise<void> {
  await app.whenReady();
  // Packaged macOS builds take the dock icon from the bundle. A development launch shows Electron's until
  // this runs, so it goes before the daemon and server start rather than after the window opens.
  const dockIcon = process.platform === "darwin" && !app.isPackaged ? appIcon("icon.png") : undefined;
  if (dockIcon) app.dock?.setIcon(dockIcon);
  const rendererRoot = process.env.ZLI_RENDERER_ROOT ?? defaultRendererRoot();
  protocol.handle("zli-v2", (request) => {
    const asset = resolveAppAsset(rendererRoot, request.url);
    if (!asset) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(asset).toString());
  });
  const databasePath = process.env.ZLI_DATABASE_PATH ?? join(app.getPath("userData"), "runtime.sqlite");
  // Test launches keep scratch chats next to their throwaway database.
  scratchFolderPath = join(process.env.ZLI_DATABASE_PATH ? dirname(databasePath) : app.getPath("userData"), "Scratch");
  daemonEndpointPath = `${databasePath}.daemon.json`;
  await ensureDesktopDaemon({
    entryPath: join(DESKTOP_DIST, "daemon-entry.js"),
    endpointPath: daemonEndpointPath,
  });
  const browserToolPaths = await startBrowserControl(databasePath);
  environment = new EnvironmentProcess({
    serverEntryPath: process.env.ZLI_SERVER_ENTRY ?? join(DESKTOP_DIST, "server-entry.js"),
    databasePath,
    extraEnv: {
      ...browserToolEnvironment(browserToolPaths),
      // Test and development launches use a throwaway control file, which must never be written
      // into the user's real agent settings where it would go stale.
      ...(process.env.ZLI_DATABASE_PATH ? { ZLI_BROWSER_USER_SETTINGS: "0" } : {}),
    },
  });
  const descriptor = await environment.start();
  runtime = await RuntimeClient.connect({
    token: descriptor.token,
    environmentId: process.env.ZLI_ENVIRONMENT_ID ?? DEFAULT_ENVIRONMENT_ID,
    connectTransport: async () => connectWebSocket(((await environment?.start()) ?? descriptor).url),
  });
  await registerTestProject(runtime);
  const desktopDiagnostics = new DesktopDiagnostics({
    app: {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      packaged: app.isPackaged,
    },
  });
  registerIpc(desktopDiagnostics);
  const window = createMainWindow(
    BrowserWindow as unknown as BrowserWindowConstructor,
    join(DESKTOP_DIST, "preload.js"),
    APP_ORIGIN,
    process.platform,
    appIcon("icon-square.png"),
  );
  const electronWindow = window as unknown as BrowserWindow;
  mainWindow = electronWindow;
  applyZoomKeys(window, zoomApp);
  const rendererUrl = process.env.ZLI_RENDERER_URL ?? `${APP_ORIGIN}/index.html`;
  popOuts = new PopOutWindows({
    create: (options) => new BrowserWindow(options) as unknown as PopOutWindowLike,
    preloadPath: join(DESKTOP_DIST, "preload.js"),
    appOrigin: APP_ORIGIN,
    rendererUrl,
    platform: process.platform,
    storePath: process.env.ZLI_DATABASE_PATH
      ? `${databasePath}.mobile-popouts.json`
      : join(app.getPath("userData"), "mobile-popouts.json"),
    icon: appIcon("icon-square.png"),
    deviceName: (deviceId) => mobile?.manager.cached().find((device) => device.deviceId === deviceId)?.name,
    viewerFor: streamViewer,
    stopViewer: async (deviceId, viewer) => mobile?.manager.stopStream(deviceId, viewer),
    onChange: (list) => sendToMobileWindows("zli:mobile:popouts", list),
    onScreen: (bounds) => screen.getAllDisplays().some((display) => overlaps(display.workArea, bounds)),
    log: (message, error) => console.error(message, error),
  });
  const taskbarDetails = process.platform === "win32" ? windowsAppDetails(process.execPath, app.isPackaged) : undefined;
  if (taskbarDetails) electronWindow.setAppDetails(taskbarDetails);
  // Closing the window goes through the quit, which may ask first and keep the window open.
  electronWindow.on("close", (event) => {
    if (quitController.exiting) return;
    event.preventDefault();
    app.quit();
  });
  notifier = await registerAgentNotifications({
    window: electronWindow,
    runtime,
    settingsPath: process.env.ZLI_DATABASE_PATH
      ? `${databasePath}.notifications.json`
      : join(app.getPath("userData"), "notification-settings.json"),
  }).catch((error: unknown) => {
    console.error("Agent notifications could not start", error);
    return undefined;
  });
  await registerUpdates({
    window: electronWindow,
    settingsPath: process.env.ZLI_DATABASE_PATH
      ? `${databasePath}.updates.json`
      : join(app.getPath("userData"), "update-settings.json"),
    openExternal: openExternalUrl,
    prepareToInstall: () => quitController.stop(),
    log: (level, message) => desktopDiagnostics.record(level, message, { component: "updates" }),
  }).catch((error: unknown) => console.error("Update checks could not start", error));
  browserManager = new BrowserManager(
    {
      create: ({ session: browserSession }) =>
        new WebContentsView({
          webPreferences: {
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            // Agents drive tabs while the Browser panel is closed; throttled pages stall their timers.
            backgroundThrottling: false,
            ...(browserSession ? { session: browserSession as Electron.Session } : {}),
          },
        }) as unknown as import("./browser/BrowserManager.js").BrowserViewLike,
    },
    {
      addChildView: (view) => electronWindow.contentView.addChildView(view as unknown as WebContentsView),
      removeChildView: (view) => electronWindow.contentView.removeChildView(view as unknown as WebContentsView),
    },
    {
      sessionModule: session,
      onProjection: (tab) => {
        void runtime
          ?.command({
            protocolVersion: 1,
            commandId: randomUUID(),
            command: { type: "browser.updated", tab },
          })
          .catch(() => undefined);
      },
      onClose: (tab) => {
        void runtime
          ?.command({
            protocolVersion: 1,
            commandId: randomUUID(),
            command: { type: "browser.closed", browserTabId: tab.browserTabId },
          })
          .catch(() => undefined);
      },
      automationFactory: (view) => {
        const debuggerLike = (view.webContents as unknown as { debugger: ElectronDebuggerLike }).debugger;
        const cdp = new CdpSession(debuggerLike);
        const captureFallback = createCaptureFallback(view.webContents as unknown as CapturableWebContents);
        const automation = new BrowserAutomation(cdp, {
          prepareInput: createInputWaker(view.webContents as unknown as WakeableWebContents),
          ...(captureFallback ? { captureFallback } : {}),
        });
        return { cdp, automation, designMode: new DesignMode(automation) };
      },
    },
  );
  runtime.subscribe((projection, change) => {
    if (window.webContents.isDestroyed?.() || !window.webContents.send) return;
    // The preload folds events into its own copy; whole projections cross only when main's was replaced.
    if (change.kind === "event") window.webContents.send("zli:runtime:projection-event", change.envelope);
    else window.webContents.send("zli:runtime:projection", projection);
  });
  runtime.subscribeTerminal((message) => {
    if (!window.webContents.isDestroyed?.() && window.webContents.send) {
      window.webContents.send("zli:runtime:terminal", message);
    }
  });
  // ready-to-show can fire before loadURL resolves, so the listener goes first. A window that misses it
  // stays hidden and Chromium stops drawing frames for it.
  window.once?.("ready-to-show", () => {
    // Chromium restores the last zoom for the app's origin, so the native controls are fitted to it first.
    fitTitleBar(window, process.platform, window.webContents.getZoomFactor?.() ?? 1);
    window.show?.();
  });
  if (window.loadURL) await window.loadURL(rendererUrl);
  if (window.isVisible?.() === false) window.show?.();
}

/**
 * Starts the agent browser control service and the zli-browser shims before the runtime server,
 * so agents the server launches always find the endpoint file and command.
 */
async function startBrowserControl(databasePath: string): Promise<BrowserToolPaths> {
  const userData = app.getPath("userData");
  const paths: BrowserToolPaths = {
    // Test and development launches pass their own database; keep their endpoint beside it so
    // they never replace the endpoint of an installed ZLI that shares the same userData folder.
    controlFile: process.env.ZLI_DATABASE_PATH
      ? `${databasePath}.browser-control.json`
      : join(userData, "browser-control.json"),
    command: process.execPath,
    script: join(DESKTOP_DIST, "zli-browser.js"),
    agentScript: join(DESKTOP_DIST, "zli.js"),
    mobileScript: join(DESKTOP_DIST, "zli-mobile.js"),
    connectScript: join(DESKTOP_DIST, "zli-connect.js"),
    shimDir: process.env.ZLI_DATABASE_PATH ? `${databasePath}.bin` : join(userData, "bin"),
  };
  const runtimeCommand: AgentControlHost["command"] = (request) =>
    runtime ? runtime.command(request) : Promise.reject(new Error("ZLI's runtime is still starting."));
  const browserActions = createBrowserControlActions({
    manager: () => browserManager,
    worktrees: () => runtime?.projection()?.worktrees ?? [],
    reveal: (event) => {
      if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send("zli:browser:reveal", event);
    },
    checkoutFor: createProjectCheckout({ projection: () => runtime?.projection(), command: runtimeCommand }),
  });
  const sendToWindow = (channel: string, payload: unknown) => {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };
  const testLaunch = Boolean(process.env.ZLI_DATABASE_PATH);
  mobileSettings = new MobileSettingsStore(
    testLaunch ? `${databasePath}.mobile-settings.json` : join(userData, "mobile-settings.json"),
  );
  mobile = createMobileService({
    os: hostOs(),
    arch: hostArch(),
    env: process.env,
    home: app.getPath("home"),
    // The Android SDK and Java ZLI installs are large, so test launches share the real folder instead of
    // downloading their own; only settings stay beside the throwaway database.
    mobileDir: join(userData, "mobile"),
    events: {
      devices: (devices) => sendToMobileWindows("zli:mobile:devices", devices),
      stream: (message) => sendToMobileWindows("zli:mobile:stream", message),
      setup: (progress) => sendToMobileWindows("zli:mobile:setup", progress),
    },
  });
  const settingsStore = mobileSettings;
  const mobileActions = createMobileControlActions({
    manager: () => mobile?.manager,
    worktrees: () => runtime?.projection()?.worktrees ?? [],
    settings: () => settingsStore.get(),
    status: () => (mobile ? mobile.status() : Promise.reject(new Error("ZLI's mobile service is not running."))),
    reveal: (event) => sendToWindow("zli:mobile:reveal", event),
  });
  const agentActions = createAgentControlActions({
    projection: () => runtime?.projection(),
    subscribe: (listener) => runtime?.subscribe(() => listener()) ?? (() => undefined),
    command: runtimeCommand,
    askToConnect: (request) => notifier?.connectorRequest(request),
  });
  // The zli agent tool shares this service and endpoint file with zli-browser, so agents need one variable.
  browserControl = new BrowserControlServer({
    endpointPath: paths.controlFile,
    dispatch: (action, input) =>
      isAgentControlAction(action)
        ? agentActions(action, input)
        : isMobileControlAction(action)
          ? mobileActions(action, input)
          : browserActions(action, input),
  });
  try {
    await browserControl.start();
  } catch (error) {
    console.error("Browser control service failed to start", error);
  }
  await writeBrowserToolShims(paths).catch((error: unknown) =>
    console.error("zli-browser shims could not be written", error),
  );
  return paths;
}

async function registerTestProject(client: RuntimeClient): Promise<void> {
  const projectPath = process.env.ZLI_TEST_PROJECT_PATH;
  if (!projectPath) return;
  const response = await client.command({
    protocolVersion: 1,
    commandId: randomUUID(),
    command: { type: "project.register", path: projectPath },
  });
  if (!response.accepted && !response.error.message.startsWith("Project is already registered:")) {
    throw new Error(`Test project bootstrap failed: ${response.error.message}`);
  }
}

function registerIpc(desktopDiagnostics: DesktopDiagnostics): void {
  ipcMain.handle("zli:runtime:dispatch", async (_event, request: unknown) => {
    if (!runtime) throw new Error("Runtime is not ready.");
    const parsed = RpcRequest.safeParse(request);
    if (!parsed.success) return runtime.command(request);
    desktopDiagnostics.record("info", "renderer command received", {
      commandId: parsed.data.commandId,
    });
    if (parsed.data.command.type === "diagnostics.createSupportBundle") {
      const allowedRoot = approvedSupportBundleRoot;
      approvedSupportBundleRoot = undefined;
      if (!allowedRoot) {
        throw new Error("Support bundle destination must stay inside the export directory.");
      }
      return runtime.command({
        ...parsed.data,
        command: {
          type: "diagnostics.createSupportBundle",
          destinationPath: parsed.data.command.destinationPath,
          allowedRoot,
          desktopLogs: desktopDiagnostics.snapshot(),
          desktopApp: desktopDiagnostics.app,
        },
      });
    }
    return runtime.command(parsed.data);
  });
  ipcMain.handle("zli:runtime:projection", () => runtime?.projection() ?? null);
  ipcMain.handle("zli:runtime:terminal:attach", (_event, input: unknown) => {
    if (!runtime) throw new Error("Runtime is not ready.");
    if (!input || typeof input !== "object" || !("terminalId" in input)) throw new Error("Terminal id is required.");
    const terminalId = TerminalId.parse((input as { terminalId: unknown }).terminalId);
    const afterSequence =
      "afterSequence" in input && typeof (input as { afterSequence?: unknown }).afterSequence === "number"
        ? (input as { afterSequence: number }).afterSequence
        : 0;
    runtime.attachTerminal(terminalId, afterSequence);
    return { accepted: true };
  });
  ipcMain.handle("zli:app:version", () => app.getVersion());
  ipcMain.handle("zli:app:quit", () => {
    app.quit();
  });
  ipcMain.handle("zli:app:zoom", (event, input: { zoom?: unknown }) => {
    if (input?.zoom !== "in" && input?.zoom !== "out" && input?.zoom !== "reset") throw new Error("Unknown zoom.");
    zoomApp(input.zoom);
  });
  ipcMain.handle("zli:test:restart-runtime", () => {
    if (process.env.ZLI_TEST_PROVIDER !== "mock") throw new Error("Test runtime controls are disabled.");
    environment?.stop();
    return { accepted: true };
  });
  ipcMain.handle("zli:test:crash-main", async () => {
    if (process.env.ZLI_TEST_PROVIDER !== "mock") throw new Error("Test runtime controls are disabled.");
    await environment?.stopAndWait();
    setTimeout(() => app.exit(86), 50);
    return { accepted: true };
  });
  ipcMain.handle("zli:dialog:open-project", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? undefined : result.filePaths[0];
  });
  ipcMain.handle("zli:dialog:save-support-bundle", async () => {
    const result = await dialog.showSaveDialog({
      defaultPath: "zli-support-bundle.zip",
      filters: [{ name: "ZLI support bundle", extensions: ["zip"] }],
    });
    if (result.canceled || !result.filePath) return undefined;
    const destination = resolve(result.filePath);
    approvedSupportBundleRoot = dirname(destination);
    return destination;
  });
  ipcMain.handle("zli:dialog:open-legacy-snapshot", async () => {
    if (process.env.ZLI_TEST_PROVIDER === "mock" && process.env.ZLI_TEST_LEGACY_SNAPSHOT_PATH) {
      return process.env.ZLI_TEST_LEGACY_SNAPSHOT_PATH;
    }
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "ZLI legacy snapshot", extensions: ["json"] }],
    });
    return result.canceled ? undefined : result.filePaths[0];
  });
  ipcMain.handle("zli:scratch:folder", async () => {
    if (!scratchFolderPath) throw new Error("ZLI is still starting.");
    return ensureScratchFolder(scratchFolderPath);
  });
  const capture: CaptureDependencies = {
    getSources: (options) => desktopCapturer.getSources(options),
    largestDisplay: () =>
      screen.getAllDisplays().reduce(
        (largest, display) => {
          const width = Math.round(display.size.width * display.scaleFactor);
          const height = Math.round(display.size.height * display.scaleFactor);
          return width * height > largest.width * largest.height ? { width, height } : largest;
        },
        { width: 1, height: 1 },
      ),
  };
  ipcMain.handle("zli:capture:sources", () => listCaptureSources(capture));
  ipcMain.handle("zli:capture:take", (_event, input: unknown) => captureSource(capture, parseSourceId(input)));
  ipcMain.handle("zli:menu:trigger", (_event, input: { command?: string }) => {
    if (!input || !["new-project", "settings", "toggle-sidebar"].includes(input.command ?? "")) {
      throw new Error("Unknown menu command.");
    }
    return { accepted: true };
  });
  ipcMain.handle("zli:browser:create", async (_event, input: unknown) => {
    if (!browserManager) throw new Error("Browser is not ready.");
    return browserManager.create(input);
  });
  ipcMain.handle("zli:browser:close", (_event, input: unknown) =>
    browserManager?.close(BrowserTabIdInput.parse(input).browserTabId),
  );
  ipcMain.handle("zli:browser:activate", async (_event, input: unknown) =>
    browserManager?.activate(BrowserTabIdInput.parse(input).browserTabId),
  );
  ipcMain.handle("zli:browser:navigate", async (_event, input: unknown) =>
    browserManager?.navigate(BrowserNavigateInput.parse(input)),
  );
  ipcMain.handle("zli:browser:hide", () => browserManager?.hide());
  ipcMain.handle("zli:browser:set-bounds", async (_event, input: unknown) => {
    const parsed = BrowserSetBoundsInput.parse(input);
    return browserManager?.setBounds(parsed.browserTabId, parsed.bounds);
  });
  ipcMain.handle("zli:browser:back", (_event, input: unknown) =>
    browserManager?.back(BrowserTabIdInput.parse(input).browserTabId),
  );
  ipcMain.handle("zli:browser:forward", (_event, input: unknown) =>
    browserManager?.forward(BrowserTabIdInput.parse(input).browserTabId),
  );
  ipcMain.handle("zli:browser:reload", (_event, input: unknown) => {
    const parsed = BrowserReloadInput.parse(input);
    return browserManager?.reload(parsed.browserTabId, parsed.hard);
  });
  ipcMain.handle("zli:browser:stop", (_event, input: unknown) =>
    browserManager?.stop(BrowserTabIdInput.parse(input).browserTabId),
  );
  ipcMain.handle("zli:browser:devtools", (_event, input: unknown) =>
    browserManager?.openDevTools(BrowserTabIdInput.parse(input).browserTabId),
  );
  ipcMain.handle("zli:browser:set-viewport", async (_event, input: unknown) => {
    if (!browserManager) throw new Error("Browser is not ready.");
    const parsed = BrowserSetViewportInput.parse(input);
    return browserManager.setViewport(parsed.browserTabId, parsed.viewport);
  });
  ipcMain.handle("zli:browser:snapshot", (_event, input: unknown) =>
    browserManager?.snapshot(BrowserTabIdInput.parse(input).browserTabId),
  );
  ipcMain.handle("zli:browser:click", (_event, input: unknown) => {
    const parsed = BrowserSelectorInput.parse(input);
    return browserManager?.click(parsed.browserTabId, { selector: parsed.selector });
  });
  ipcMain.handle("zli:browser:fill", (_event, input: unknown) => {
    const parsed = BrowserFillInput.parse(input);
    return browserManager?.fill(parsed.browserTabId, { selector: parsed.selector, value: parsed.value });
  });
  ipcMain.handle("zli:browser:press", (_event, input: unknown) => {
    const parsed = BrowserPressInput.parse(input);
    return browserManager?.press(parsed.browserTabId, { key: parsed.key });
  });
  ipcMain.handle("zli:browser:wait-network-idle", (_event, input: unknown) => {
    const parsed = BrowserWaitForNetworkIdleInput.parse(input);
    return browserManager?.waitForNetworkIdle(parsed.browserTabId, {
      ...(parsed.idleMs === undefined ? {} : { idleMs: parsed.idleMs }),
      ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }),
    });
  });
  ipcMain.handle("zli:browser:screenshot", (_event, input: unknown) => {
    const parsed = BrowserScreenshotInput.parse(input);
    return browserManager?.screenshot(
      parsed.browserTabId,
      parsed.format === undefined ? {} : { format: parsed.format },
    );
  });
  ipcMain.handle("zli:browser:inspect", (_event, input: unknown) => {
    const parsed = BrowserSelectorInput.parse(input);
    return browserManager?.inspectElement(parsed.browserTabId, { selector: parsed.selector });
  });
  ipcMain.handle("zli:browser:design-inspect", (_event, input: unknown) => {
    const parsed = BrowserSelectorInput.parse(input);
    return browserManager?.designInspect(parsed.browserTabId, { selector: parsed.selector });
  });
  ipcMain.handle("zli:browser:design-pick", (_event, input: unknown) =>
    browserManager?.designPick(BrowserTabIdInput.parse(input).browserTabId),
  );
  ipcMain.handle("zli:browser:design-cancel", (_event, input: unknown) =>
    browserManager?.designCancel(BrowserTabIdInput.parse(input).browserTabId),
  );
  ipcMain.handle("zli:browser:design-mark", (_event, input: unknown) => {
    const parsed = BrowserDesignMarkInput.parse(input);
    return browserManager?.designMark(parsed.browserTabId, parsed.marks, parsed.drop);
  });
  ipcMain.handle("zli:browser:design-capture", (_event, input: unknown) => {
    const parsed = BrowserDesignCaptureInput.parse(input);
    return browserManager?.designCapture(parsed.browserTabId, { bounds: parsed.bounds, strokes: parsed.strokes });
  });
  ipcMain.handle("zli:browser:console", (_event, input: unknown) =>
    browserManager?.consoleEntries(BrowserTabIdInput.parse(input).browserTabId),
  );
  ipcMain.handle("zli:browser:network", (_event, input: unknown) =>
    browserManager?.networkEntries(BrowserTabIdInput.parse(input).browserTabId),
  );
  registerMobileIpc();
  ipcMain.handle("zli:app:open-external", async (_event, input: unknown) => {
    const url = input && typeof input === "object" && "url" in input ? (input as { url: unknown }).url : undefined;
    if (typeof url !== "string" || !shouldOpenExternal(url))
      throw new Error("Only http and https links can be opened.");
    await openExternalUrl(url);
    return { accepted: true };
  });
  ipcMain.handle("zli:open-in:apps", async (): Promise<OpenInApp[]> => {
    const apps = await installedApps();
    return Promise.all(
      apps.map(async (entry) => {
        const icon = await appIconUrl(entry.executable);
        return { id: entry.id, name: entry.name, kind: entry.kind, ...(icon ? { icon } : {}) };
      }),
    );
  });
  ipcMain.handle("zli:open-in:open", async (_event, input: unknown) => {
    const request = OpenInRequest.parse(input);
    // Only folders ZLI already manages can be opened, so the renderer cannot start an app on any path.
    const worktree = runtime
      ?.projection()
      ?.worktrees.find((entry) => entry.worktreeId === request.worktreeId && entry.status !== "cancelled");
    if (!worktree) throw new Error("This worktree is no longer in ZLI.");
    if (!existsSync(worktree.path)) throw new Error(`The folder is missing: ${worktree.path}`);
    const target = (await installedApps()).find((entry) => entry.id === request.appId);
    if (!target) throw new Error("That app is no longer installed.");
    if (process.env.ZLI_TEST_PROVIDER === "mock") {
      lastOpenIn = { appId: target.id, path: worktree.path };
      return { accepted: true };
    }
    await launchApp(target, worktree.path, nodeEnvironment().platform, (path) => shell.openPath(path));
    return { accepted: true };
  });
  ipcMain.handle("zli:test:take-open-in", () => {
    if (process.env.ZLI_TEST_PROVIDER !== "mock") throw new Error("Test runtime controls are disabled.");
    const opened = lastOpenIn ?? null;
    lastOpenIn = undefined;
    return opened;
  });
  ipcMain.handle("zli:test:take-external-url", () => {
    if (process.env.ZLI_TEST_PROVIDER !== "mock") throw new Error("Test runtime controls are disabled.");
    const url = lastExternalUrl ?? null;
    lastExternalUrl = undefined;
    return url;
  });
}

function registerMobileIpc(): void {
  const handlers = mobileIpcHandlers({
    service: () => mobile,
    settings: () => mobileSettings,
    popOuts: () => popOuts,
  });
  for (const [channel, handle] of Object.entries(handlers))
    ipcMain.handle(channel, (event, input: unknown) => handle(input, { viewer: streamViewer(event.sender.id) }));
}

/**
 * Chromium shares a page zoom across windows on the same origin, so pop-outs follow the main window and
 * every window's native controls are refitted.
 */
function zoomApp(zoom: Zoom): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const factor = nextZoomFactor(mainWindow.webContents.getZoomFactor(), zoom);
  mainWindow.webContents.setZoomFactor(factor);
  fitTitleBar(mainWindow, process.platform, factor);
  popOuts?.fitTitleBars(factor);
}

/** Device and stream events go to the main window and to every pop-out window showing a device. */
function sendToMobileWindows(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send(channel, payload);
  for (const target of popOuts?.targets() ?? []) target.send?.(channel, payload);
}

function overlaps(area: WindowBounds, bounds: WindowBounds): boolean {
  return (
    bounds.x < area.x + area.width &&
    bounds.x + bounds.width > area.x &&
    bounds.y < area.y + area.height &&
    bounds.y + bounds.height > area.y
  );
}

function installedApps(): Promise<ResolvedApp[]> {
  if (!openInApps || Date.now() - openInApps.at > OPEN_IN_TTL_MS) {
    openInApps = { at: Date.now(), apps: detectApps(nodeEnvironment()).catch(() => []) };
  }
  return openInApps.apps;
}

/** The app's own icon. Linux has no per-app file icons, so the menu shows a generic one there. */
function appIconUrl(executable: string): Promise<string | undefined> {
  if (process.platform === "linux" || !executable) return Promise.resolve(undefined);
  let icon = openInIcons.get(executable);
  if (!icon) {
    icon = app
      .getFileIcon(executable, { size: "normal" })
      .then((image) => (image.isEmpty() ? undefined : image.toDataURL()))
      .catch(() => undefined);
    openInIcons.set(executable, icon);
  }
  return icon;
}

async function openExternalUrl(url: string): Promise<void> {
  if (process.env.ZLI_TEST_PROVIDER === "mock") lastExternalUrl = url;
  else await shell.openExternal(url);
}

function connectWebSocket(url: string): Promise<RuntimeTransport> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const listeners = new Set<(message: unknown) => void>();
    const closeListeners = new Set<() => void>();
    socket.once("open", () => {
      resolve({
        send: (message) => socket.send(JSON.stringify(message)),
        close: () => socket.close(),
        onMessage: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        onClose: (listener) => {
          closeListeners.add(listener);
          return () => closeListeners.delete(listener);
        },
      });
    });
    socket.on("message", (value) => {
      let message: unknown;
      try {
        message = JSON.parse(value.toString()) as unknown;
      } catch {
        return;
      }
      for (const listener of listeners) listener(message);
    });
    socket.on("close", () => {
      for (const listener of closeListeners) listener();
    });
    socket.once("error", reject);
  });
}

void main().catch((error) => {
  console.error(error);
  app.quit();
});

app.on("will-quit", () => {
  browserControl?.stop();
});

const quitController = new QuitController({
  quit: () => app.quit(),
  // Test launches quit without asking, because nobody is there to answer the dialog.
  busyAgents: () => (process.env.ZLI_TEST_PROVIDER === "mock" ? 0 : busyAgentCount(runtime?.projection())),
  confirm: confirmQuit,
  shutdown: shutdownRuntime,
  log: (message, error) => console.error(message, error),
});

app.on("before-quit", (event) => quitController.beforeQuit(event));

// ZLI has one window, and nothing reopens it, so closing it quits on every platform.
app.on("window-all-closed", () => app.quit());

async function confirmQuit(busyCount: number): Promise<boolean> {
  const options: Electron.MessageBoxOptions = {
    type: "warning",
    message: "Quit ZLI?",
    detail: quitWarning(busyCount),
    buttons: ["Quit anyway", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const { response } =
    mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
  return response === 0;
}

/** Stops chats, agent CLIs, and terminals, so nothing ZLI started keeps running after it quits. */
async function shutdownRuntime(): Promise<void> {
  browserManager?.closeAll({ persist: false });
  // Before the mobile service, so each window's bounds are saved and its stream share is let go first.
  await popOuts?.closeAll().catch((error: unknown) => console.error("Pop-out windows did not close cleanly", error));
  // Emulators ZLI started would otherwise keep running, and scrcpy servers keep the device awake.
  await mobile?.dispose().catch((error: unknown) => console.error("Mobile devices did not stop cleanly", error));
  mobile = undefined;
  // Closed first: a client that sees the server go away starts it again to reconnect.
  runtime?.close();
  runtime = undefined;
  await environment?.shutdown();
  // After the server, which would otherwise start a new daemon when this one goes away.
  if (daemonEndpointPath) await shutdownDesktopDaemon({ endpointPath: daemonEndpointPath });
}

/**
 * Packaged builds keep renderer/ beside the app root. `electron apps/desktop/dist/main.js`
 * makes the app path dist/, while Vite writes the renderer one level up.
 */
function defaultRendererRoot(): string {
  const candidates = [join(app.getAppPath(), "renderer"), resolve(DESKTOP_DIST, "..", "renderer")];
  return candidates.find((candidate) => existsSync(join(candidate, "index.html"))) ?? candidates[0] ?? "renderer";
}
