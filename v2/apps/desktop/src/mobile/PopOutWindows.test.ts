import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MobilePopOut } from "@zli-v2/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type PopOutWindowLike, PopOutWindows, restoredBounds, type WindowBounds } from "./PopOutWindows.js";

type Listener = (...args: unknown[]) => void;

class FakeWindow {
  static nextId = 1;
  readonly options: Record<string, unknown>;
  readonly listeners = new Map<string, Listener[]>();
  readonly contentsListeners = new Map<string, Listener[]>();
  openHandler: (() => unknown) | undefined;
  destroyed = false;
  minimized = false;
  focused = 0;
  loaded: string | undefined;
  alwaysOnTop: boolean;
  readonly onTopCalls: [boolean, string | undefined][] = [];
  aspect: { ratio: number; extra?: { width: number; height: number } } | undefined;
  bounds: WindowBounds;
  readonly webContents = {
    id: FakeWindow.nextId++,
    setWindowOpenHandler: (handler: () => unknown) => {
      this.openHandler = handler;
    },
    on: (event: string, listener: Listener) => {
      this.contentsListeners.set(event, [...(this.contentsListeners.get(event) ?? []), listener]);
    },
    reload: () => undefined,
    isDestroyed: () => this.destroyed,
    send: () => undefined,
  };

  constructor(options: Record<string, unknown>) {
    this.options = options;
    this.alwaysOnTop = options.alwaysOnTop === true;
    this.bounds = {
      x: typeof options.x === "number" ? options.x : 100,
      y: typeof options.y === "number" ? options.y : 80,
      width: options.width as number,
      height: options.height as number,
    };
  }

  on(event: string, listener: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  once(event: string, listener: Listener) {
    this.on(event, listener);
  }
  emit(event: string) {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
  async loadURL(url: string) {
    this.loaded = url;
  }
  show() {}
  focus() {
    this.focused += 1;
  }
  isMinimized() {
    return this.minimized;
  }
  restore() {
    this.minimized = false;
  }
  isDestroyed() {
    return this.destroyed;
  }
  close() {
    this.emit("close");
    this.destroyed = true;
    this.emit("closed");
  }
  getBounds() {
    return { ...this.bounds };
  }
  getContentSize() {
    return [this.bounds.width, this.bounds.height];
  }
  setContentSize(width: number, height: number) {
    this.bounds = { ...this.bounds, width, height };
  }
  setAlwaysOnTop(flag: boolean, level?: string) {
    this.alwaysOnTop = flag;
    this.onTopCalls.push([flag, level]);
  }
  setAspectRatio(ratio: number, extra?: { width: number; height: number }) {
    this.aspect = { ratio, ...(extra ? { extra } : {}) };
  }
}

let folder: string;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "zli-popouts-"));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

function popOuts(options: { workAreas?: WindowBounds[]; platform?: NodeJS.Platform } = {}) {
  const windows: FakeWindow[] = [];
  const changes: MobilePopOut[][] = [];
  const stopViewer = vi.fn(async (_deviceId: string, _viewer: string) => undefined);
  const storePath = join(folder, "mobile-popouts.json");
  const manager = new PopOutWindows({
    create: (windowOptions) => {
      const window = new FakeWindow(windowOptions);
      windows.push(window);
      return window as unknown as PopOutWindowLike;
    },
    preloadPath: "/zli/preload.js",
    appOrigin: "zli-v2://app",
    rendererUrl: "zli-v2://app/index.html",
    platform: options.platform ?? "linux",
    storePath,
    deviceName: (deviceId) => (deviceId === "android-avd:Pixel_8" ? "Pixel_8" : undefined),
    viewerFor: (id) => `window-${id}`,
    stopViewer,
    onChange: (list) => changes.push(list),
    ...(options.workAreas ? { workAreas: () => options.workAreas ?? [] } : {}),
  });
  return { manager, windows, changes, stopViewer, storePath };
}

const pixel = "android-avd:Pixel_8";

function only(windows: FakeWindow[], index = 0): FakeWindow {
  const window = windows[index];
  if (!window) throw new Error(`No window ${index}`);
  return window;
}

describe("pop-out windows", () => {
  it("opens a device in a window with the main window's preload, sandbox, and navigation policy", async () => {
    const { manager, windows, changes } = popOuts();
    expect(await manager.open(pixel)).toEqual([{ deviceId: pixel, pinned: false }]);
    const [window] = windows;
    expect(window?.options).toMatchObject({
      title: "Pixel_8",
      width: 400,
      height: 820,
      show: false,
      alwaysOnTop: false,
      titleBarStyle: "hidden",
      titleBarOverlay: { height: 36 },
      webPreferences: {
        preload: "/zli/preload.js",
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webviewTag: false,
      },
    });
    expect(window?.loaded).toBe("zli-v2://app/index.html?view=mobile-device&deviceId=android-avd%3APixel_8");
    expect(window?.openHandler?.()).toEqual({ action: "deny" });
    let blocked = false;
    for (const listener of window?.contentsListeners.get("will-navigate") ?? [])
      listener({ preventDefault: () => (blocked = true) }, "https://example.com/");
    expect(blocked).toBe(true);
    expect(changes.at(-1)).toEqual([{ deviceId: pixel, pinned: false }]);
    expect(manager.targets()).toEqual([window?.webContents]);
  });

  it("focuses the device's window when asked to open it again", async () => {
    const { manager, windows } = popOuts();
    await Promise.all([manager.open(pixel), manager.open(pixel)]);
    expect(windows).toHaveLength(1);
    only(windows).minimized = true;
    await manager.open(pixel);
    expect(windows).toHaveLength(1);
    expect(windows[0]?.minimized).toBe(false);
    expect(windows[0]?.focused).toBe(2);
    await manager.open("ios:UDID-1");
    expect(windows).toHaveLength(2);
    expect(windows[1]?.options.title).toBe("Device");
  });

  it("pins the window on top and remembers the pin and bounds for the next time", async () => {
    const first = popOuts();
    await first.manager.open(pixel);
    expect(await first.manager.pin(pixel, true)).toEqual([{ deviceId: pixel, pinned: true }]);
    expect(first.windows[0]?.onTopCalls).toEqual([[true, undefined]]);
    only(first.windows).bounds = { x: 40, y: 50, width: 360, height: 700 };
    await first.manager.closeAll();
    expect(first.windows[0]?.destroyed).toBe(true);
    expect(JSON.parse(await readFile(first.storePath, "utf8"))).toEqual({
      version: 1,
      devices: { [pixel]: { pinned: true, bounds: { x: 40, y: 50, width: 360, height: 700 } } },
    });

    const second = popOuts();
    await second.manager.open(pixel);
    expect(second.windows[0]?.options).toMatchObject({ x: 40, y: 50, width: 360, height: 700, alwaysOnTop: true });
    expect(second.manager.list()).toEqual([{ deviceId: pixel, pinned: true }]);
    expect(second.windows[0]?.onTopCalls).toEqual([[true, undefined]]);
    await second.manager.pin(pixel, false);
    expect(second.windows[0]?.onTopCalls.at(-1)).toEqual([false, undefined]);
  });

  it("keeps the window above other apps at the floating level on macOS", async () => {
    const { manager, windows } = popOuts({ platform: "darwin" });
    await manager.open(pixel);
    await manager.pin(pixel, true);
    await manager.pin(pixel, false);
    expect(only(windows).onTopCalls).toEqual([
      [true, "floating"],
      [false, "floating"],
    ]);
  });

  it("saves the bounds once the window stops moving, so they survive a crash", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { manager, windows, storePath } = popOuts();
      await manager.open(pixel);
      const window = only(windows);
      window.bounds = { x: 10, y: 20, width: 300, height: 600 };
      window.emit("moved");
      window.bounds = { x: 30, y: 40, width: 320, height: 640 };
      window.emit("resized");
      vi.advanceTimersByTime(499);
      await expect(readFile(storePath, "utf8")).rejects.toThrow();
      vi.advanceTimersByTime(1);
      vi.useRealTimers();
      await vi.waitFor(async () =>
        expect(JSON.parse(await readFile(storePath, "utf8"))).toEqual({
          version: 1,
          devices: { [pixel]: { pinned: false, bounds: { x: 30, y: 40, width: 320, height: 640 } } },
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores saved bounds that no longer land on a display, and a broken settings file", async () => {
    const offScreen = popOuts({ workAreas: [{ x: 0, y: 0, width: 1920, height: 1040 }] });
    await writeFile(
      offScreen.storePath,
      JSON.stringify({
        version: 1,
        devices: { [pixel]: { pinned: true, bounds: { x: 9000, y: 0, width: 400, height: 800 } } },
      }),
    );
    await offScreen.manager.open(pixel);
    expect(offScreen.windows[0]?.options).toMatchObject({ width: 400, height: 800, alwaysOnTop: true });
    expect(offScreen.windows[0]?.options).not.toHaveProperty("x");

    const broken = popOuts();
    await writeFile(broken.storePath, "{ not json");
    await broken.manager.open(pixel);
    expect(broken.windows[0]?.options).toMatchObject({ width: 400, height: 820, alwaysOnTop: false });
  });

  it("stops the window's share of the stream and reports the change when it closes", async () => {
    const { manager, windows, changes, stopViewer } = popOuts();
    await manager.open(pixel);
    const viewer = `window-${windows[0]?.webContents.id}`;
    expect(manager.close(pixel)).toEqual([]);
    expect(stopViewer).toHaveBeenCalledWith(pixel, viewer);
    expect(changes.at(-1)).toEqual([]);
    expect(manager.targets()).toEqual([]);
    await manager.open(pixel);
    expect(windows).toHaveLength(2);
    await manager.closeAll();
    expect(windows[1]?.destroyed).toBe(true);
  });

  it("keeps the device's shape, and reshapes the window after a rotation without growing it", async () => {
    const { manager, windows } = popOuts();
    await manager.open(pixel);
    const window = only(windows);
    // 400 x 820 content with 24 x 120 of bars and padding leaves a 376 x 700 device, close to 0.53.
    manager.setAspect({ deviceId: pixel, aspect: 0.53, extraWidth: 24, extraHeight: 120 });
    expect(window.aspect).toEqual({ ratio: 0.53, extra: { width: 24, height: 120 } });
    expect(window.getContentSize()).toEqual([400, 820]);
    manager.setAspect({ deviceId: pixel, aspect: 1 / 0.47, extraWidth: 24, extraHeight: 120 });
    const [width = 0, height = 0] = window.getContentSize();
    expect(width - 24).toBe(700);
    expect(height - 120).toBe(Math.round(700 * 0.47));
    manager.setAspect({ deviceId: "ios:none", aspect: 1, extraWidth: 0, extraHeight: 0 });
  });
  it("grows or shrinks the window by the room around the device, so the device keeps its size", async () => {
    const { manager, windows } = popOuts();
    await manager.open(pixel);
    const window = only(windows);
    manager.setAspect({ deviceId: pixel, aspect: 0.53, extraWidth: 24, extraHeight: 120 });
    expect(window.getContentSize()).toEqual([400, 820]);
    // The bottom bar is hidden: 44 fewer pixels around the device.
    manager.setAspect({ deviceId: pixel, aspect: 0.53, extraWidth: 24, extraHeight: 76 });
    expect(window.getContentSize()).toEqual([400, 776]);
    expect(window.aspect).toEqual({ ratio: 0.53, extra: { width: 24, height: 76 } });
    manager.setAspect({ deviceId: pixel, aspect: 0.53, extraWidth: 24, extraHeight: 120 });
    expect(window.getContentSize()).toEqual([400, 820]);
  });

  it("saves the size a maximized window returns to, not the maximized one", async () => {
    const { manager, windows, storePath } = popOuts();
    await manager.open(pixel);
    const window = only(windows) as FakeWindow & { getNormalBounds?: () => WindowBounds };
    window.bounds = { x: 0, y: 0, width: 1920, height: 1040 };
    window.getNormalBounds = () => ({ x: 40, y: 50, width: 360, height: 700 });
    await manager.closeAll();
    expect(JSON.parse(await readFile(storePath, "utf8")).devices[pixel].bounds).toEqual({
      x: 40,
      y: 50,
      width: 360,
      height: 700,
    });
  });
});

describe("restored bounds", () => {
  const laptop = { x: 0, y: 0, width: 1440, height: 860 };
  const monitor = { x: 1440, y: -200, width: 2560, height: 1400 };

  it("opens at the default size the first time", () => {
    expect(restoredBounds(undefined, [laptop])).toEqual({ width: 400, height: 820 });
  });

  it("restores the saved place on any display, even partly off its edge", () => {
    expect(restoredBounds({ x: 2000, y: 100, width: 400, height: 800 }, [laptop, monitor])).toEqual({
      x: 2000,
      y: 100,
      width: 400,
      height: 800,
    });
    expect(restoredBounds({ x: 1200, y: 400, width: 400, height: 800 }, [laptop])).toEqual({
      x: 1200,
      y: 400,
      width: 400,
      height: 800,
    });
  });

  it("drops the place when the title bar is off every display, as after unplugging a monitor", () => {
    expect(restoredBounds({ x: 2000, y: 100, width: 400, height: 800 }, [laptop])).toEqual({ width: 400, height: 800 });
    // Only a sliver of the title bar shows, too little to drag.
    expect(restoredBounds({ x: 1400, y: 100, width: 400, height: 800 }, [laptop])).toEqual({ width: 400, height: 800 });
    // The title bar is above the top of the screen.
    expect(restoredBounds({ x: 100, y: -30, width: 400, height: 800 }, [laptop])).toEqual({ width: 400, height: 800 });
  });

  it("fits a window saved on a bigger display to the largest one left", () => {
    expect(restoredBounds({ x: 3000, y: 0, width: 900, height: 1300 }, [laptop])).toEqual({ width: 900, height: 860 });
  });
});
