import { isAllowedMainNavigation } from "../security/NavigationPolicy.js";

export type BrowserWindowLike = {
  webContents: {
    setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }): void;
    on(event: "will-navigate", listener: (event: { preventDefault(): void }, url: string) => void): void;
    on(event: "render-process-gone", listener: () => void): void;
    reload(): void;
    isDestroyed?(): boolean;
    send?(channel: string, value: unknown): void;
  };
  loadURL?(url: string): Promise<void>;
  once?(event: "ready-to-show", listener: () => void): void;
  show?(): void;
};

export type BrowserWindowConstructor = new (options: Record<string, unknown>) => BrowserWindowLike;

export function secureWebPreferences(preloadPath: string, partition?: string): Record<string, unknown> {
  return {
    preload: preloadPath,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webviewTag: false,
    ...(partition ? { partition } : {}),
  };
}

export function createMainWindow(
  BrowserWindow: BrowserWindowConstructor,
  preloadPath: string,
  appOrigin: string,
): BrowserWindowLike {
  const window = new BrowserWindow({
    title: "ZLI",
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#181818",
    webPreferences: secureWebPreferences(preloadPath),
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedMainNavigation(url, appOrigin)) event.preventDefault();
  });
  window.webContents.on("render-process-gone", () => window.webContents.reload());
  return window;
}
