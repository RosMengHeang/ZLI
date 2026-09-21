import { app, BrowserWindow, dialog, ipcMain, net, protocol, session, WebContentsView } from "electron";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket } from "ws";

import { RuntimeClient, type RuntimeTransport } from "@zli-v2/client-runtime";
import {
  BrowserFillInput,
  BrowserNavigateInput,
  BrowserPressInput,
  BrowserReloadInput,
  BrowserScreenshotInput,
  BrowserSelectorInput,
  BrowserSetBoundsInput,
  BrowserTabIdInput,
  BrowserWaitForNetworkIdleInput,
  RpcRequest,
  TerminalId,
} from "@zli-v2/contracts";

import { BrowserManager } from "./browser/BrowserManager.js";
import { BrowserAutomation } from "./browser/BrowserAutomation.js";
import { CdpSession, type ElectronDebuggerLike } from "./browser/CdpSession.js";
import { DesignMode } from "./browser/DesignMode.js";
import { DesktopDiagnostics } from "./diagnostics/DesktopDiagnostics.js";
import { EnvironmentProcess } from "./runtime/EnvironmentProcess.js";
import { resolveAppAsset } from "./window/ElectronProtocol.js";
import { createMainWindow, type BrowserWindowConstructor } from "./window/ElectronWindow.js";

const DEFAULT_ENVIRONMENT_ID = "00000000-0000-4000-8000-000000000001";
const APP_ORIGIN = "zli-v2://app";
const DESKTOP_DIST = dirname(fileURLToPath(import.meta.url));

protocol.registerSchemesAsPrivileged([{
  scheme: "zli-v2",
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

let environment: EnvironmentProcess | undefined;
let runtime: RuntimeClient | undefined;
let browserManager: BrowserManager | undefined;

async function main(): Promise<void> {
  await app.whenReady();
  const rendererRoot = process.env.ZLI_RENDERER_ROOT ?? join(app.getAppPath(), "renderer");
  protocol.handle("zli-v2", (request) => {
    const asset = resolveAppAsset(rendererRoot, request.url);
    if (!asset) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(asset).toString());
  });
  environment = new EnvironmentProcess({
    serverEntryPath: process.env.ZLI_SERVER_ENTRY ?? join(DESKTOP_DIST, "server-entry.js"),
    databasePath: process.env.ZLI_DATABASE_PATH ?? join(app.getPath("userData"), "runtime.sqlite"),
  });
  const descriptor = await environment.start();
  runtime = await RuntimeClient.connect({
    token: descriptor.token,
    environmentId: process.env.ZLI_ENVIRONMENT_ID ?? DEFAULT_ENVIRONMENT_ID,
    connectTransport: async () => connectWebSocket((await environment?.start() ?? descriptor).url),
  });
  await registerTestProject(runtime);
  registerIpc(new DesktopDiagnostics());
  const window = createMainWindow(BrowserWindow as unknown as BrowserWindowConstructor, join(DESKTOP_DIST, "preload.js"), APP_ORIGIN);
  const electronWindow = window as unknown as BrowserWindow;
  browserManager = new BrowserManager(
    {
      create: ({ session: browserSession }) => new WebContentsView({
        webPreferences: {
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
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
        void runtime?.command({
          protocolVersion: 1,
          commandId: randomUUID(),
          command: { type: "browser.updated", tab },
        }).catch(() => undefined);
      },
      onClose: (tab) => {
        void runtime?.command({
          protocolVersion: 1,
          commandId: randomUUID(),
          command: { type: "browser.closed", browserTabId: tab.browserTabId },
        }).catch(() => undefined);
      },
      automationFactory: (view) => {
        const debuggerLike = (view.webContents as unknown as { debugger: ElectronDebuggerLike }).debugger;
        const cdp = new CdpSession(debuggerLike);
        const automation = new BrowserAutomation(cdp);
        return { cdp, automation, designMode: new DesignMode(automation) };
      },
    },
  );
  runtime.subscribe((projection) => {
    if (!window.webContents.isDestroyed?.() && window.webContents.send) {
      window.webContents.send("zli:runtime:projection", projection);
    }
  });
  runtime.subscribeTerminal((message) => {
    if (!window.webContents.isDestroyed?.() && window.webContents.send) {
      window.webContents.send("zli:runtime:terminal", message);
    }
  });
  const rendererUrl = process.env.ZLI_RENDERER_URL ?? `${APP_ORIGIN}/index.html`;
  if (window.loadURL) await window.loadURL(rendererUrl);
  window.once?.("ready-to-show", () => window.show?.());
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
      return runtime.command({
        ...parsed.data,
        command: {
          ...parsed.data.command,
          desktopLogs: desktopDiagnostics.snapshot(),
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
    const afterSequence = "afterSequence" in input && typeof (input as { afterSequence?: unknown }).afterSequence === "number"
      ? (input as { afterSequence: number }).afterSequence
      : 0;
    runtime.attachTerminal(terminalId, afterSequence);
    return { accepted: true };
  });
  ipcMain.handle("zli:app:version", () => app.getVersion());
  ipcMain.handle("zli:app:quit", () => { app.quit(); });
  ipcMain.handle("zli:test:restart-runtime", () => {
    if (process.env.ZLI_TEST_PROVIDER !== "mock") throw new Error("Test runtime controls are disabled.");
    environment?.stop();
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
    return result.canceled ? undefined : result.filePath;
  });
  ipcMain.handle("zli:dialog:open-legacy-snapshot", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "ZLI legacy snapshot", extensions: ["json"] }],
    });
    return result.canceled ? undefined : result.filePaths[0];
  });
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
  ipcMain.handle("zli:browser:close", (_event, input: unknown) => browserManager?.close(BrowserTabIdInput.parse(input).browserTabId));
  ipcMain.handle("zli:browser:activate", async (_event, input: unknown) => browserManager?.activate(BrowserTabIdInput.parse(input).browserTabId));
  ipcMain.handle("zli:browser:navigate", async (_event, input: unknown) => browserManager?.navigate(BrowserNavigateInput.parse(input)));
  ipcMain.handle("zli:browser:set-bounds", async (_event, input: unknown) => {
    const parsed = BrowserSetBoundsInput.parse(input);
    return browserManager?.setBounds(parsed.browserTabId, parsed.bounds);
  });
  ipcMain.handle("zli:browser:back", (_event, input: unknown) => browserManager?.back(BrowserTabIdInput.parse(input).browserTabId));
  ipcMain.handle("zli:browser:forward", (_event, input: unknown) => browserManager?.forward(BrowserTabIdInput.parse(input).browserTabId));
  ipcMain.handle("zli:browser:reload", (_event, input: unknown) => {
    const parsed = BrowserReloadInput.parse(input);
    return browserManager?.reload(parsed.browserTabId, parsed.hard);
  });
  ipcMain.handle("zli:browser:stop", (_event, input: unknown) => browserManager?.stop(BrowserTabIdInput.parse(input).browserTabId));
  ipcMain.handle("zli:browser:devtools", (_event, input: unknown) => browserManager?.openDevTools(BrowserTabIdInput.parse(input).browserTabId));
  ipcMain.handle("zli:browser:snapshot", (_event, input: unknown) => browserManager?.snapshot(BrowserTabIdInput.parse(input).browserTabId));
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
    return browserManager?.screenshot(parsed.browserTabId, parsed.format === undefined ? {} : { format: parsed.format });
  });
  ipcMain.handle("zli:browser:inspect", (_event, input: unknown) => {
    const parsed = BrowserSelectorInput.parse(input);
    return browserManager?.inspectElement(parsed.browserTabId, { selector: parsed.selector });
  });
  ipcMain.handle("zli:browser:design-inspect", (_event, input: unknown) => {
    const parsed = BrowserSelectorInput.parse(input);
    return browserManager?.designInspect(parsed.browserTabId, { selector: parsed.selector });
  });
  ipcMain.handle("zli:browser:console", (_event, input: unknown) => browserManager?.consoleEntries(BrowserTabIdInput.parse(input).browserTabId));
  ipcMain.handle("zli:browser:network", (_event, input: unknown) => browserManager?.networkEntries(BrowserTabIdInput.parse(input).browserTabId));
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
        onMessage: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        onClose: (listener) => { closeListeners.add(listener); return () => closeListeners.delete(listener); },
      });
    });
    socket.on("message", (value) => {
      let message: unknown;
      try { message = JSON.parse(value.toString()) as unknown; } catch { return; }
      for (const listener of listeners) listener(message);
    });
    socket.on("close", () => { for (const listener of closeListeners) listener(); });
    socket.once("error", reject);
  });
}

void main().catch((error) => {
  console.error(error);
  app.quit();
});

app.on("window-all-closed", () => {
  browserManager?.closeAll({ persist: false });
  runtime?.close();
  environment?.stop();
  if (process.platform !== "darwin") app.quit();
});
