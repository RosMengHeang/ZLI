import { readFile } from "node:fs/promises";

import { type MobilePopOut, type MobilePopOutAspectInput, MobilePopOutSaved } from "@zli-v2/contracts";
import { themeColors } from "@zli-v2/ui/colors";

import { writeJsonFile } from "../storage/writeJsonFile.js";
import {
  applyNavigationPolicy,
  type BrowserWindowLike,
  fitTitleBar,
  secureWebPreferences,
  titleBarOptions,
} from "../window/ElectronWindow.js";

export type WindowBounds = { x: number; y: number; width: number; height: number };

export type PopOutWindowLike = BrowserWindowLike & {
  readonly webContents: BrowserWindowLike["webContents"] & { readonly id: number };
  loadURL(url: string): Promise<void>;
  on(event: "close" | "closed" | "moved" | "resized", listener: () => void): void;
  focus(): void;
  close(): void;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  getBounds(): WindowBounds;
  /** The bounds the window returns to when it is no longer maximized. */
  getNormalBounds?(): WindowBounds;
  getContentSize(): number[];
  setContentSize(width: number, height: number): void;
  setAlwaysOnTop(flag: boolean, level?: "floating"): void;
  setAspectRatio(aspectRatio: number, extraSize?: { width: number; height: number }): void;
};

export type PopOutWindowsOptions = {
  /** Makes the window. Electron's BrowserWindow in the app, a fake in tests. */
  readonly create: (options: Record<string, unknown>) => PopOutWindowLike;
  /** The main window's preload, so the pop-out gets the same bridge with the same checks. */
  readonly preloadPath: string;
  readonly appOrigin: string;
  /** The renderer page; the pop-out loads it with ?view=mobile-device&deviceId=... */
  readonly rendererUrl: string;
  readonly platform: NodeJS.Platform;
  /** Where the pin and the bounds of each device's window are kept. */
  readonly storePath: string;
  readonly deviceName: (deviceId: string) => string | undefined;
  /** The stream viewer a window's renderer starts streams as, so closing the window stops its share. */
  readonly viewerFor: (webContentsId: number) => string;
  readonly stopViewer: (deviceId: string, viewer: string) => Promise<void>;
  readonly onChange: (popOuts: MobilePopOut[]) => void;
  /** The work area of every connected display, so saved bounds that no longer land on one are not restored. */
  readonly workAreas?: () => WindowBounds[];
  readonly icon?: string | undefined;
  readonly log?: (message: string, error: unknown) => void;
};

/** The pop-out's title bar is slimmer than the main window's. */
export const POP_OUT_TITLE_BAR_HEIGHT = 36;
const DEFAULT_SIZE = { width: 400, height: 820 };
const MIN_SIZE = { width: 260, height: 360 };
/** How far the window's shape may drift from the device's before ZLI reshapes it, as a ratio. */
const SHAPE_SLACK = 1.08;
/** How much of the title bar must be on a display for the person to grab it and drag the window back. */
const GRAB_WIDTH = 100;
/** Moving fires many events on macOS, so the bounds are saved once the window has been still this long. */
const BOUNDS_SAVE_DELAY_MS = 500;

type Saved = MobilePopOutSaved;
type Size = { width: number; height: number };
type Open = {
  window: PopOutWindowLike;
  viewer: string;
  pinned: boolean;
  extra?: Size;
  saveTimer?: ReturnType<typeof setTimeout>;
};

/**
 * Desktop windows that each show one device outside the Mobile panel. One window per device: opening a device
 * again focuses its window. Each device's pin and window bounds are remembered across restarts.
 */
export class PopOutWindows {
  readonly #options: PopOutWindowsOptions;
  readonly #open = new Map<string, Open>();
  #saved: Promise<Record<string, Saved>> | undefined;
  #writes: Promise<void> = Promise.resolve();
  readonly #pending = new Set<Promise<void>>();

  constructor(options: PopOutWindowsOptions) {
    this.#options = options;
  }

  list(): MobilePopOut[] {
    return [...this.#open].map(([deviceId, entry]) => ({ deviceId, pinned: entry.pinned }));
  }

  /** The renderers of the open windows, which get the same device and stream events as the main window. */
  targets(): BrowserWindowLike["webContents"][] {
    return [...this.#open.values()]
      .filter((entry) => !entry.window.isDestroyed() && !entry.window.webContents.isDestroyed?.())
      .map((entry) => entry.window.webContents);
  }

  async open(deviceId: string): Promise<MobilePopOut[]> {
    if (this.#focus(deviceId)) return this.list();
    const saved = (await this.#load())[deviceId];
    // Another open of the same device may have finished while the file was read.
    if (this.#focus(deviceId)) return this.list();
    const pinned = saved?.pinned ?? false;
    const window = this.#options.create({
      title: this.#options.deviceName(deviceId) ?? "Device",
      ...(this.#options.icon ? { icon: this.#options.icon } : {}),
      ...restoredBounds(saved?.bounds, this.#options.workAreas?.() ?? []),
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      show: false,
      alwaysOnTop: pinned,
      backgroundColor: themeColors.canvas,
      ...titleBarOptions(this.#options.platform, POP_OUT_TITLE_BAR_HEIGHT),
      webPreferences: secureWebPreferences(this.#options.preloadPath),
    });
    applyNavigationPolicy(window, this.#options.appOrigin);
    if (pinned) this.#keepOnTop(window, true);
    // Read now: webContents can no longer be asked for its id once the window is gone.
    const entry: Open = { window, viewer: this.#options.viewerFor(window.webContents.id), pinned };
    this.#open.set(deviceId, entry);
    const saveSoon = () => {
      clearTimeout(entry.saveTimer);
      entry.saveTimer = setTimeout(() => {
        if (!window.isDestroyed()) void this.#remember(deviceId, { pinned: entry.pinned, bounds: boundsOf(window) });
      }, BOUNDS_SAVE_DELAY_MS);
    };
    window.on("moved", saveSoon);
    window.on("resized", saveSoon);
    window.on("close", () => {
      clearTimeout(entry.saveTimer);
      if (!window.isDestroyed()) void this.#remember(deviceId, { pinned: entry.pinned, bounds: boundsOf(window) });
    });
    window.on("closed", () => {
      clearTimeout(entry.saveTimer);
      if (this.#open.get(deviceId) === entry) this.#open.delete(deviceId);
      this.#options
        .stopViewer(deviceId, entry.viewer)
        .catch((error: unknown) => this.#options.log?.("A pop-out window's stream did not stop", error));
      this.#changed();
    });
    window.once?.("ready-to-show", () => window.show?.());
    this.#changed();
    const url = new URL(this.#options.rendererUrl);
    url.search = new URLSearchParams({ view: "mobile-device", deviceId }).toString();
    await window.loadURL(url.toString());
    if (!window.isDestroyed())
      fitTitleBar(window, this.#options.platform, window.webContents.getZoomFactor?.() ?? 1, POP_OUT_TITLE_BAR_HEIGHT);
    return this.list();
  }

  /** Refits every pop-out's native controls after the shared page zoom changes. */
  fitTitleBars(factor: number): void {
    for (const { window } of this.#open.values())
      if (!window.isDestroyed()) fitTitleBar(window, this.#options.platform, factor, POP_OUT_TITLE_BAR_HEIGHT);
  }

  close(deviceId: string): MobilePopOut[] {
    const entry = this.#open.get(deviceId);
    if (entry && !entry.window.isDestroyed()) entry.window.close();
    return this.list();
  }

  async pin(deviceId: string, pinned: boolean): Promise<MobilePopOut[]> {
    const entry = this.#open.get(deviceId);
    if (!entry || entry.window.isDestroyed()) return this.list();
    this.#keepOnTop(entry.window, pinned);
    entry.pinned = pinned;
    this.#changed();
    await this.#remember(deviceId, { pinned, bounds: boundsOf(entry.window) });
    return this.list();
  }

  /**
   * Keeps the window in the device's shape while it is resized, and reshapes it when the shape is clearly off,
   * as after a rotation. The longer side stays as it was, so a rotated window does not grow. When the room
   * around the device changes, as when the bottom bar is hidden, the window grows or shrinks by that much so
   * the device keeps its size.
   */
  setAspect(input: MobilePopOutAspectInput): void {
    const entry = this.#open.get(input.deviceId);
    if (!entry || entry.window.isDestroyed()) return;
    // The renderer measures in CSS pixels; the window is sized in screen points, which differ when zoomed.
    const factor = entry.window.webContents.getZoomFactor?.() ?? 1;
    const extra = { width: input.extraWidth * factor, height: input.extraHeight * factor };
    const previous = entry.extra;
    entry.extra = extra;
    entry.window.setAspectRatio(input.aspect, extra);
    const [width = 0, height = 0] = entry.window.getContentSize();
    const roomChanged = previous !== undefined && (previous.width !== extra.width || previous.height !== extra.height);
    const content = roomChanged
      ? {
          width: Math.max(MIN_SIZE.width, width + extra.width - previous.width),
          height: Math.max(MIN_SIZE.height, height + extra.height - previous.height),
        }
      : { width, height };
    const device = { width: content.width - extra.width, height: content.height - extra.height };
    if (device.width <= 0 || device.height <= 0) return;
    const drift = Math.abs(Math.log(device.width / device.height / input.aspect));
    let next = content;
    if (drift > Math.log(SHAPE_SLACK)) {
      const long = Math.max(device.width, device.height);
      const shaped =
        input.aspect >= 1 ? { width: long, height: long / input.aspect } : { width: long * input.aspect, height: long };
      next = { width: shaped.width + extra.width, height: shaped.height + extra.height };
    } else if (!roomChanged) return;
    entry.window.setContentSize(Math.round(next.width), Math.round(next.height));
  }

  /** Closes every window and waits until their bounds are saved. */
  async closeAll(): Promise<void> {
    // Saved before closing, because Electron may emit close after this returns.
    for (const [deviceId, entry] of this.#open)
      if (!entry.window.isDestroyed())
        void this.#remember(deviceId, { pinned: entry.pinned, bounds: boundsOf(entry.window) });
    for (const deviceId of [...this.#open.keys()]) this.close(deviceId);
    while (this.#pending.size > 0) await Promise.all([...this.#pending]);
  }

  #keepOnTop(window: PopOutWindowLike, pinned: boolean): void {
    // On macOS the floating level keeps the window above other apps' normal windows. Windows has one topmost
    // band, which the plain call uses.
    if (this.#options.platform === "darwin") window.setAlwaysOnTop(pinned, "floating");
    else window.setAlwaysOnTop(pinned);
  }

  #focus(deviceId: string): boolean {
    const entry = this.#open.get(deviceId);
    if (!entry || entry.window.isDestroyed()) return false;
    if (entry.window.isMinimized()) entry.window.restore();
    entry.window.focus();
    return true;
  }

  #changed(): void {
    this.#options.onChange(this.list());
  }

  #load(): Promise<Record<string, Saved>> {
    this.#saved ??= readFile(this.#options.storePath, "utf8").then(
      (text) => parseSaved(text),
      () => ({}),
    );
    return this.#saved;
  }

  #remember(deviceId: string, value: Saved): Promise<void> {
    const done = (async () => {
      const saved = await this.#load();
      saved[deviceId] = value;
      this.#writes = this.#writes
        .then(() => writeJsonFile(this.#options.storePath, { version: 1, devices: saved }))
        .catch((error: unknown) => this.#options.log?.("Pop-out window settings could not be saved", error));
      await this.#writes;
    })();
    this.#pending.add(done);
    void done.finally(() => this.#pending.delete(done));
    return done;
  }
}

function boundsOf(window: PopOutWindowLike): WindowBounds {
  return window.getNormalBounds?.() ?? window.getBounds();
}

/**
 * Where a device's window opens: its saved place when enough of its title bar lands on a display to drag it,
 * otherwise its saved size, fitted to the largest display, wherever the system puts a new window.
 */
export function restoredBounds(saved: WindowBounds | undefined, areas: readonly WindowBounds[]): WindowBounds | Size {
  if (!saved) return DEFAULT_SIZE;
  const size = {
    width: Math.max(MIN_SIZE.width, saved.width),
    height: Math.max(MIN_SIZE.height, saved.height),
  };
  if (areas.length === 0) return { x: saved.x, y: saved.y, ...size };
  const largest = areas.reduce((best, area) => (area.width * area.height > best.width * best.height ? area : best));
  const fitted = {
    width: Math.max(MIN_SIZE.width, Math.min(size.width, largest.width)),
    height: Math.max(MIN_SIZE.height, Math.min(size.height, largest.height)),
  };
  const titleBar = { x: saved.x, y: saved.y, width: fitted.width, height: POP_OUT_TITLE_BAR_HEIGHT };
  const grabbable = areas.some((area) => {
    const width = Math.min(titleBar.x + titleBar.width, area.x + area.width) - Math.max(titleBar.x, area.x);
    const height = Math.min(titleBar.y + titleBar.height, area.y + area.height) - Math.max(titleBar.y, area.y);
    return width >= Math.min(GRAB_WIDTH, titleBar.width) && height >= POP_OUT_TITLE_BAR_HEIGHT / 2;
  });
  return grabbable ? { x: saved.x, y: saved.y, ...fitted } : fitted;
}

function parseSaved(text: string): Record<string, Saved> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {};
  }
  const devices = (value as { devices?: unknown } | null)?.devices;
  if (!devices || typeof devices !== "object") return {};
  const result: Record<string, Saved> = {};
  // Each device is read on its own, so one broken entry does not forget the others.
  for (const [deviceId, entry] of Object.entries(devices as Record<string, unknown>)) {
    const parsed = MobilePopOutSaved.safeParse(entry);
    if (parsed.success) result[deviceId] = parsed.data;
  }
  return result;
}
