import { describe, expect, it } from "vitest";

import { createMainWindow, secureWebPreferences, titleBarOptions } from "./ElectronWindow.js";

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
