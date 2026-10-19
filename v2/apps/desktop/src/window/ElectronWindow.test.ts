import { describe, expect, it } from "vitest";

import { createMainWindow, secureWebPreferences } from "./ElectronWindow.js";

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
