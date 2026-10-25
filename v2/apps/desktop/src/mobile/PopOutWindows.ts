import { readFile } from "node:fs/promises";

import type { MobilePopOut, MobilePopOutAspectInput } from "@zli-v2/contracts";
import { themeColors } from "@zli-v2/ui/colors";

import { writeJsonFile } from "../storage/writeJsonFile.js";
import {
  applyNavigationPolicy,
  type BrowserWindowLike,
  secureWebPreferences,
  titleBarOptions,
} from "../window/ElectronWindow.js";

export type WindowBounds = { x: number; y: number; width: number; height: number };

export type PopOutWindowLike = BrowserWindowLike & {
  readonly webContents: BrowserWindowLike["webContents"] & { readonly id: number };
  loadURL(url: string): Promise<void>;
  on(event: "close" | "closed", listener: () => void): void;
  focus(): void;
  close(): void;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  getBounds(): WindowBounds;
  getContentSize(): number[];
  setContentSize(width: number, height: number): void;
  setAlwaysOnTop(flag: boolean): void;
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
  /** Whether saved bounds still land on a connected display. */
  readonly onScreen?: (bounds: WindowBounds) => boolean;
  readonly icon?: string | undefined;
  readonly log?: (message: string, error: unknown) => void;
};

/** The pop-out's title bar is slimmer than the main window's. */
export const POP_OUT_TITLE_BAR_HEIGHT = 36;
const DEFAULT_SIZE = { width: 400, height: 820 };
const MIN_SIZE = { width: 260, height: 360 };
/** How far the window's shape may drift from the device's before ZLI reshapes it, as a ratio. */
const SHAPE_SLACK = 1.08;

type Saved = { pinned: boolean; bounds?: WindowBounds };
type Open = { window: PopOutWindowLike; viewer: string; pinned: boolean };

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
    const bounds = saved?.bounds && (this.#options.onScreen?.(saved.bounds) ?? true) ? saved.bounds : undefined;
    const pinned = saved?.pinned ?? false;
    const window = this.#options.create({
      title: this.#options.deviceName(deviceId) ?? "Device",
      ...(this.#options.icon ? { icon: this.#options.icon } : {}),
      ...(bounds ?? DEFAULT_SIZE),
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      show: false,
      alwaysOnTop: pinned,
      backgroundColor: themeColors.canvas,
      ...titleBarOptions(this.#options.platform, POP_OUT_TITLE_BAR_HEIGHT),
      webPreferences: secureWebPreferences(this.#options.preloadPath),
    });
    applyNavigationPolicy(window, this.#options.appOrigin);
    // Read now: webContents can no longer be asked for its id once the window is gone.
    const entry: Open = { window, viewer: this.#options.viewerFor(window.webContents.id), pinned };
    this.#open.set(deviceId, entry);
    window.on("close", () => {
      if (!window.isDestroyed()) void this.#remember(deviceId, { pinned: entry.pinned, bounds: window.getBounds() });
    });
    window.on("closed", () => {
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
    return this.list();
  }

  close(deviceId: string): MobilePopOut[] {
    const entry = this.#open.get(deviceId);
    if (entry && !entry.window.isDestroyed()) entry.window.close();
    return this.list();
  }

  async pin(deviceId: string, pinned: boolean): Promise<MobilePopOut[]> {
    const entry = this.#open.get(deviceId);
    if (!entry || entry.window.isDestroyed()) return this.list();
    entry.window.setAlwaysOnTop(pinned);
    entry.pinned = pinned;
    this.#changed();
    await this.#remember(deviceId, { pinned, bounds: entry.window.getBounds() });
    return this.list();
  }

  /**
   * Keeps the window in the device's shape while it is resized, and reshapes it when the shape is clearly off,
   * as after a rotation. The longer side stays as it was, so a rotated window does not grow.
   */
  setAspect(input: MobilePopOutAspectInput): void {
    const entry = this.#open.get(input.deviceId);
    if (!entry || entry.window.isDestroyed()) return;
    const extra = { width: input.extraWidth, height: input.extraHeight };
    entry.window.setAspectRatio(input.aspect, extra);
    const [width = 0, height = 0] = entry.window.getContentSize();
    const device = { width: width - extra.width, height: height - extra.height };
    if (device.width <= 0 || device.height <= 0) return;
    const drift = Math.abs(Math.log(device.width / device.height / input.aspect));
    if (drift <= Math.log(SHAPE_SLACK)) return;
    const long = Math.max(device.width, device.height);
    const next =
      input.aspect >= 1 ? { width: long, height: long / input.aspect } : { width: long * input.aspect, height: long };
    entry.window.setContentSize(Math.round(next.width + extra.width), Math.round(next.height + extra.height));
  }

  /** Closes every window and waits until their bounds are saved. */
  async closeAll(): Promise<void> {
    // Saved before closing, because Electron may emit close after this returns.
    for (const [deviceId, entry] of this.#open)
      if (!entry.window.isDestroyed())
        void this.#remember(deviceId, { pinned: entry.pinned, bounds: entry.window.getBounds() });
    for (const deviceId of [...this.#open.keys()]) this.close(deviceId);
    while (this.#pending.size > 0) await Promise.all([...this.#pending]);
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
  for (const [deviceId, entry] of Object.entries(devices as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const { pinned, bounds } = entry as { pinned?: unknown; bounds?: unknown };
    result[deviceId] = { pinned: pinned === true, ...(isBounds(bounds) ? { bounds } : {}) };
  }
  return result;
}

function isBounds(value: unknown): value is WindowBounds {
  if (!value || typeof value !== "object") return false;
  const { x, y, width, height } = value as Record<string, unknown>;
  return (
    [x, y, width, height].every((part) => typeof part === "number" && Number.isFinite(part)) &&
    (width as number) >= MIN_SIZE.width &&
    (height as number) >= MIN_SIZE.height
  );
}
