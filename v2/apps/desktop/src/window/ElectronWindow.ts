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
    on(event: "before-input-event", listener: (event: { preventDefault(): void }, input: ZoomInput) => void): void;
    getZoomFactor?(): number;
    setZoomFactor?(factor: number): void;
    reload(): void;
    isDestroyed?(): boolean;
    send?(channel: string, value: unknown): void;
  };
  loadURL?(url: string): Promise<void>;
  once?(event: "ready-to-show", listener: () => void): void;
  show?(): void;
  isVisible?(): boolean;
  setTitleBarOverlay?(options: { height: number }): void;
  setWindowButtonPosition?(position: { x: number; y: number }): void;
};

export type ZoomInput = { type: string; key: string; control: boolean; meta: boolean; alt: boolean };

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
/** macOS draws its traffic lights 14px tall. */
const TRAFFIC_LIGHT_HEIGHT = 14;

/**
 * The renderer draws its own title bar, so the native one and its menu row are hidden. Windows and
 * Linux keep native window controls through the overlay; macOS keeps its traffic lights, centered in
 * the bar. Menu accelerators still work without the visible menu.
 */
export function titleBarOptions(platform: NodeJS.Platform, height = TITLE_BAR_HEIGHT): Record<string, unknown> {
  if (platform === "darwin") {
    return { titleBarStyle: "hiddenInset", trafficLightPosition: trafficLights(height), titleBarOverlay: true };
  }
  return {
    titleBarStyle: "hidden",
    titleBarOverlay: { color: themeColors.canvas, symbolColor: themeColors.muted, height },
  };
}

function trafficLights(height: number): { x: number; y: number } {
  return { x: 16, y: Math.round((height - TRAFFIC_LIGHT_HEIGHT) / 2) };
}

/** Grows or shrinks the native window controls with the page zoom, so they stay centered in the renderer's bar. */
export function fitTitleBar(
  window: BrowserWindowLike,
  platform: NodeJS.Platform,
  factor: number,
  height = TITLE_BAR_HEIGHT,
): void {
  const scaled = Math.round(height * factor);
  if (platform === "darwin") window.setWindowButtonPosition?.(trafficLights(scaled));
  else window.setTitleBarOverlay?.({ height: scaled });
}

/** Keeps a window that shows the app on the app's own pages: no new windows, and no navigation away. */
export function applyNavigationPolicy(window: BrowserWindowLike, appOrigin: string): void {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedMainNavigation(url, appOrigin)) event.preventDefault();
  });
  // Reply previews are sandboxed frames; a link inside one would otherwise load the web page in place.
  window.webContents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && !isAllowedSubframeNavigation(event.url)) event.preventDefault();
  });
  window.webContents.on("render-process-gone", () => window.webContents.reload());
}

export type Zoom = "in" | "out" | "reset";

/** The zoom factors the app steps through, from 50% to 300%. */
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;

/** The step after the current factor, staying within 50% and 300%. */
export function nextZoomFactor(current: number, zoom: Zoom): number {
  if (zoom === "reset") return 1;
  if (zoom === "in") return ZOOM_STEPS.find((step) => step > current + 0.001) ?? ZOOM_STEPS.at(-1) ?? 1;
  return ZOOM_STEPS.findLast((step) => step < current - 0.001) ?? ZOOM_STEPS[0];
}

/**
 * Ctrl/Cmd with +, - and 0 zoom the whole app. Handled here, before the renderer sees the keys, so a
 * focused terminal cannot swallow them, and so Ctrl+= works without Shift on Windows and Linux.
 */
export function applyZoomKeys(window: BrowserWindowLike, onZoom: (zoom: Zoom) => void): void {
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.alt || !(input.control || input.meta)) return;
    const zoom =
      input.key === "=" || input.key === "+"
        ? "in"
        : input.key === "-"
          ? "out"
          : input.key === "0"
            ? "reset"
            : undefined;
    if (!zoom) return;
    event.preventDefault();
    onZoom(zoom);
  });
}

export function createMainWindow(
  BrowserWindow: BrowserWindowConstructor,
  preloadPath: string,
  appOrigin: string,
  platform: NodeJS.Platform = process.platform,
  icon?: string,
): BrowserWindowLike {
  const window = new BrowserWindow({
    title: "ZLI",
    ...(icon ? { icon } : {}),
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: themeColors.canvas,
    ...titleBarOptions(platform),
    webPreferences: secureWebPreferences(preloadPath),
  });
  applyNavigationPolicy(window, appOrigin);
  return window;
}
