import { app, BrowserWindow, dialog, ipcMain, net, protocol } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";

import { RuntimeClient, type RuntimeTransport } from "@zli-v2/client-runtime";

import { EnvironmentProcess } from "./runtime/EnvironmentProcess.js";
import { resolveAppAsset } from "./window/ElectronProtocol.js";
import { createMainWindow, type BrowserWindowConstructor } from "./window/ElectronWindow.js";

const DEFAULT_ENVIRONMENT_ID = "00000000-0000-4000-8000-000000000001";
const APP_ORIGIN = "zli-v2://app";

protocol.registerSchemesAsPrivileged([{
  scheme: "zli-v2",
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

let environment: EnvironmentProcess | undefined;
let runtime: RuntimeClient | undefined;

async function main(): Promise<void> {
  await app.whenReady();
  const rendererRoot = process.env.ZLI_RENDERER_ROOT ?? join(app.getAppPath(), "renderer");
  protocol.handle("zli-v2", (request) => {
    const asset = resolveAppAsset(rendererRoot, request.url);
    if (!asset) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(asset).toString());
  });
  environment = new EnvironmentProcess({
    serverEntryPath: process.env.ZLI_SERVER_ENTRY ?? join(app.getAppPath(), "server-entry.js"),
    databasePath: process.env.ZLI_DATABASE_PATH ?? join(app.getPath("userData"), "runtime.sqlite"),
  });
  const descriptor = await environment.start();
  runtime = await RuntimeClient.connect({
    token: descriptor.token,
    environmentId: process.env.ZLI_ENVIRONMENT_ID ?? DEFAULT_ENVIRONMENT_ID,
    connectTransport: () => connectWebSocket(descriptor.url),
  });
  registerIpc();
  const window = createMainWindow(BrowserWindow as unknown as BrowserWindowConstructor, join(__dirname, "preload.js"), APP_ORIGIN);
  runtime.subscribe((projection) => {
    if (!window.webContents.isDestroyed?.() && window.webContents.send) {
      window.webContents.send("zli:runtime:projection", projection);
    }
  });
  const rendererUrl = process.env.ZLI_RENDERER_URL ?? `${APP_ORIGIN}/index.html`;
  if (window.loadURL) await window.loadURL(rendererUrl);
  window.once?.("ready-to-show", () => window.show?.());
}

function registerIpc(): void {
  ipcMain.handle("zli:runtime:dispatch", async (_event, request: unknown) => {
    if (!runtime) throw new Error("Runtime is not ready.");
    return runtime.command(request);
  });
  ipcMain.handle("zli:runtime:projection", () => runtime?.projection() ?? null);
  ipcMain.handle("zli:app:version", () => app.getVersion());
  ipcMain.handle("zli:app:quit", () => { app.quit(); });
  ipcMain.handle("zli:dialog:open-project", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? undefined : result.filePaths[0];
  });
  ipcMain.handle("zli:menu:trigger", (_event, input: { command?: string }) => {
    if (!input || !["new-project", "settings", "toggle-sidebar"].includes(input.command ?? "")) {
      throw new Error("Unknown menu command.");
    }
    return { accepted: true };
  });
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
  runtime?.close();
  environment?.stop();
  if (process.platform !== "darwin") app.quit();
});
