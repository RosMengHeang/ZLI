import { describe, expect, it } from "vitest";

import {
  applyZoomKeys,
  createMainWindow,
  fitTitleBar,
  nextZoomFactor,
  secureWebPreferences,
  titleBarOptions,
} from "./ElectronWindow.js";

describe("ElectronWindow", () => {
  it("turns Ctrl or Cmd with +, - and 0 into zoom requests", () => {
    let onInput: ((event: { preventDefault(): void }, input: unknown) => void) | undefined;
    const window = {
      webContents: {
        setWindowOpenHandler: () => undefined,
        on: (name: string, listener: never) => {
          if (name === "before-input-event") onInput = listener;
        },
        reload: () => undefined,
      },
    };
    const zooms: string[] = [];
    applyZoomKeys(window, (zoom) => zooms.push(zoom));
    const press = (key: string, mods: { control?: boolean; meta?: boolean; alt?: boolean } = { control: true }) => {
      let prevented = false;
      onInput?.(
        { preventDefault: () => (prevented = true) },
        { type: "keyDown", key, control: false, meta: false, alt: false, ...mods },
      );
      return prevented;
    };
    expect(press("=")).toBe(true);
    expect(press("+", { meta: true })).toBe(true);
    expect(press("-")).toBe(true);
    expect(press("0")).toBe(true);
    expect(press("=", {})).toBe(false);
    expect(press("=", { control: true, alt: true })).toBe(false);
    expect(press("k")).toBe(false);
    expect(zooms).toEqual(["in", "in", "out", "reset"]);
  });

  it("steps zoom between 50% and 300%", () => {
    expect(nextZoomFactor(1, "in")).toBe(1.1);
    expect(nextZoomFactor(1, "out")).toBe(0.9);
    expect(nextZoomFactor(2.5, "in")).toBe(3);
    expect(nextZoomFactor(3, "in")).toBe(3);
    expect(nextZoomFactor(0.67, "out")).toBe(0.5);
    expect(nextZoomFactor(0.5, "out")).toBe(0.5);
    expect(nextZoomFactor(2.5, "reset")).toBe(1);
    // A factor between steps moves to the neighbouring step.
    expect(nextZoomFactor(1.3, "in")).toBe(1.5);
    expect(nextZoomFactor(1.3, "out")).toBe(1.25);
  });

  it("scales the native window controls with the zoom", () => {
    const overlays: unknown[] = [];
    const buttons: unknown[] = [];
    const window = {
      webContents: { setWindowOpenHandler: () => undefined, on: () => undefined, reload: () => undefined },
      setTitleBarOverlay: (options: unknown) => overlays.push(options),
      setWindowButtonPosition: (position: unknown) => buttons.push(position),
    };
    fitTitleBar(window, "linux", 2);
    fitTitleBar(window, "win32", 0.5, 36);
    fitTitleBar(window, "darwin", 3);
    expect(overlays).toEqual([{ height: 88 }, { height: 18 }]);
    expect(buttons).toEqual([{ x: 16, y: 59 }]);
  });

  it("creates a Chromium window with the security posture required by Codex/Cursor-style shells", () => {
    const created: Array<Record<string, unknown>> = [];
    const webContents = {
      setWindowOpenHandler: (handler: unknown) => {
        (webContents as { openHandler?: unknown }).openHandler = handler;
      },
      on: () => undefined,
      reload: () => undefined,
    };
    class FakeBrowserWindow {
      webContents = webContents;
      constructor(options: Record<string, unknown>) {
        created.push(options);
      }
    }
    createMainWindow(FakeBrowserWindow, "/tmp/preload.js", "zli-v2://app");
    expect(created[0]).toMatchObject({
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    expect(secureWebPreferences("/tmp/preload.js")).toMatchObject({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: "/tmp/preload.js",
    });
  });

  it("replaces the native title bar while keeping native window controls", () => {
    const created: Array<Record<string, unknown>> = [];
    class FakeBrowserWindow {
      webContents = { setWindowOpenHandler: () => undefined, on: () => undefined, reload: () => undefined };
      constructor(options: Record<string, unknown>) {
        created.push(options);
      }
    }
    createMainWindow(FakeBrowserWindow, "/tmp/preload.js", "zli-v2://app", "win32");
    expect(created[0]).toMatchObject({ titleBarStyle: "hidden", titleBarOverlay: { height: 44 } });
    expect(titleBarOptions("darwin")).toMatchObject({ titleBarStyle: "hiddenInset", titleBarOverlay: true });
    expect(titleBarOptions("darwin")).toMatchObject({ trafficLightPosition: { x: 16, y: 15 } });
  });

  it("centers the native window controls in a shorter title bar", () => {
    expect(titleBarOptions("win32", 36)).toMatchObject({ titleBarOverlay: { height: 36 } });
    expect(titleBarOptions("darwin", 36)).toMatchObject({ trafficLightPosition: { x: 16, y: 11 } });
  });

  it("sets the window icon only when one is given", () => {
    const created: Array<Record<string, unknown>> = [];
    class FakeBrowserWindow {
      webContents = { setWindowOpenHandler: () => undefined, on: () => undefined, reload: () => undefined };
      constructor(options: Record<string, unknown>) {
        created.push(options);
      }
    }
    createMainWindow(FakeBrowserWindow, "/tmp/preload.js", "zli-v2://app", "linux", "/app/build/icon-square.png");
    createMainWindow(FakeBrowserWindow, "/tmp/preload.js", "zli-v2://app", "linux");
    expect(created[0]).toMatchObject({ icon: "/app/build/icon-square.png" });
    expect(created[1]).not.toHaveProperty("icon");
  });

  it("keeps frames inside the app window on inline documents", () => {
    let onFrameNavigate: ((event: { url: string; isMainFrame: boolean; preventDefault(): void }) => void) | undefined;
    const webContents = {
      setWindowOpenHandler: () => undefined,
      on: (event: string, listener: unknown) => {
        if (event === "will-frame-navigate") onFrameNavigate = listener as typeof onFrameNavigate;
      },
      reload: () => undefined,
    };
    class FakeBrowserWindow {
      webContents = webContents;
    }
    createMainWindow(FakeBrowserWindow, "/tmp/preload.js", "zli-v2://app");
    const navigate = (url: string, isMainFrame = false) => {
      let blocked = false;
      onFrameNavigate?.({ url, isMainFrame, preventDefault: () => (blocked = true) });
      return blocked;
    };
    expect(navigate("about:srcdoc")).toBe(false);
    expect(navigate("https://example.com/")).toBe(true);
    expect(navigate("zli-v2://app/index.html")).toBe(true);
    expect(navigate("https://example.com/", true)).toBe(false);
  });

  it("reloads the window when Chromium reports that the renderer process has crashed", () => {
    let onRendererGone: (() => void) | undefined;
    let reloads = 0;
    const webContents = {
      setWindowOpenHandler: () => undefined,
      on: (event: string, listener: unknown) => {
        if (event === "render-process-gone") onRendererGone = listener as () => void;
      },
      reload: () => {
        reloads += 1;
      },
    };
    class FakeBrowserWindow {
      webContents = webContents;
    }

    createMainWindow(FakeBrowserWindow, "/tmp/preload.js", "zli-v2://app");
    onRendererGone?.();

    expect(reloads).toBe(1);
  });
});
