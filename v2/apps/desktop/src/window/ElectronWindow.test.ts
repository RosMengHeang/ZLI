import { describe, expect, it } from "vitest";

import {
  applyWindowChrome,
  createMainWindow,
  parseWindowChrome,
  secureWebPreferences,
  titleBarOptions,
} from "./ElectronWindow.js";

describe("ElectronWindow", () => {
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

describe("window chrome", () => {
  it("accepts only two #rrggbb colors from the renderer", () => {
    expect(parseWindowChrome({ background: "#ECECEF", symbols: "#52525b" })).toEqual({
      background: "#ececef",
      symbols: "#52525b",
    });
    expect(parseWindowChrome({ background: "red", symbols: "#52525b" })).toBeUndefined();
    expect(parseWindowChrome({ background: "#ececef" })).toBeUndefined();
    expect(parseWindowChrome(null)).toBeUndefined();
  });

  it("recolors the title bar overlay except on macOS", () => {
    const calls: unknown[] = [];
    const window = {
      setBackgroundColor: (color: string) => calls.push(["background", color]),
      setTitleBarOverlay: (options: unknown) => calls.push(["overlay", options]),
    };
    applyWindowChrome(window, { background: "#120a10", symbols: "#d3afc3" }, "win32");
    applyWindowChrome(window, { background: "#000000", symbols: "#86c99b" }, "darwin");
    expect(calls).toEqual([
      ["background", "#120a10"],
      ["overlay", { color: "#120a10", symbolColor: "#d3afc3" }],
      ["background", "#000000"],
    ]);
  });

  it("opens the window in the remembered colors", () => {
    expect(titleBarOptions("win32", 44, { background: "#ececef", symbols: "#52525b" })).toMatchObject({
      titleBarOverlay: { color: "#ececef", symbolColor: "#52525b", height: 44 },
    });
  });
});
