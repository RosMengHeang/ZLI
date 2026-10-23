import { themeColors } from "@zli-v2/ui/colors";

import { isAllowedMainNavigation, isAllowedSubframeNavigation } from "../security/NavigationPolicy.js";

export type BrowserWindowLike = {
  webContents: {
    setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }): void;
    on(event: "will-navigate", listener: (event: { preventDefault(): void }, url: string) => void): void;
    on(
      event: "will-frame-navigate",
      listener: (event: { url: string; isMainFrame: boolean; preventDefault(): void }) => void,
    ): void;
    on(event: "render-process-gone", listener: () => void): void;
    reload(): void;
    isDestroyed?(): boolean;
    send?(channel: string, value: unknown): void;
  };
  loadURL?(url: string): Promise<void>;
  once?(event: "ready-to-show", listener: () => void): void;
  show?(): void;
  isVisible?(): boolean;
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

/** The renderer's top bar height, so the native chrome lines up with the app around it. */
const TITLE_BAR_HEIGHT = 44;

/**
 * The renderer draws its own title bar, so the native one and its menu row are hidden. Windows and
 * Linux keep native window controls through the overlay; macOS keeps its traffic lights. Menu
 * accelerators still work without the visible menu.
 */
export function titleBarOptions(platform: NodeJS.Platform): Record<string, unknown> {
  if (platform === "darwin") {
    return { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 15 }, titleBarOverlay: true };
  }
  return {
    titleBarStyle: "hidden",
    titleBarOverlay: { color: themeColors.canvas, symbolColor: themeColors.muted, height: TITLE_BAR_HEIGHT },
  };
}

export function createMainWindow(
  BrowserWindow: BrowserWindowConstructor,
  preloadPath: string,
  appOrigin: string,
  platform: NodeJS.Platform = process.platform,
): BrowserWindowLike {
  const window = new BrowserWindow({
    title: "ZLI",
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: themeColors.canvas,
    ...titleBarOptions(platform),
    webPreferences: secureWebPreferences(preloadPath),
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedMainNavigation(url, appOrigin)) event.preventDefault();
  });
  // Reply previews are sandboxed frames; a link inside one would otherwise load the web page in place.
  window.webContents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && !isAllowedSubframeNavigation(event.url)) event.preventDefault();
  });
  window.webContents.on("render-process-gone", () => window.webContents.reload());
  return window;
}
