import { browserViewportForPreset } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import type { BrowserAutomation } from "./BrowserAutomation.js";
import {
  BrowserManager,
  type BrowserViewFactory,
  emulationFor,
  fitViewport,
  toWindowPixels,
} from "./BrowserManager.js";

const worktreeId = "00000000-0000-4000-8000-000000000001";
const profileId = "00000000-0000-4000-8000-000000000002";

function createFakeView(url: string) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const loadedUrls: string[] = [];
  const view = {
    webContents: {
      getURL: () => url,
      getTitle: () => "Example",
      loadURL: async (next: string) => {
        loadedUrls.push(next);
        url = next;
      },
      canGoBack: () => false,
      canGoForward: () => false,
      goBack: () => undefined,
      goForward: () => undefined,
      reload: () => undefined,
      reloadIgnoringCache: () => undefined,
      stop: () => undefined,
      setWindowOpenHandler: () => undefined,
      on: (event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener);
      },
      isDestroyed: () => false,
      destroy: () => undefined,
    },
    emit: (event: string, ...args: unknown[]) => listeners.get(event)?.(...args),
    setBounds: (bounds: unknown) => {
      view.bounds = bounds;
    },
    setVisible: (visible: boolean) => {
      view.visible = visible;
    },
    bounds: undefined as unknown,
    visible: false,
    loadedUrls,
  };
  return view;
}

describe("BrowserManager", () => {
  it("hosts Chromium WebContentsView tabs per worktree and activates one at a time", async () => {
    const views: Array<ReturnType<typeof createFakeView>> = [];
    const factory: BrowserViewFactory = {
      create: () => {
        const view = createFakeView("https://example.com");
        views.push(view);
        return view;
      },
    };
    const host = { addChildView: () => undefined, removeChildView: () => undefined };
    const manager = new BrowserManager(factory, host);
    const first = await manager.create({ worktreeId, profileId, url: "https://example.com" });
    const second = await manager.create({ worktreeId, profileId, url: "https://example.org" });

    await manager.activate(first.browserTabId);
    expect(views[0]?.visible).toBe(true);
    expect(views[1]?.visible).toBe(false);
    await manager.activate(second.browserTabId);
    expect(views[0]?.visible).toBe(false);
    expect(views[1]?.visible).toBe(true);
    expect(manager.list(worktreeId)).toHaveLength(2);
  });

  it("rejects unsafe URLs and invalid bounds before Chromium navigation", async () => {
    const manager = new BrowserManager(
      { create: () => createFakeView("https://example.com") },
      { addChildView: () => undefined, removeChildView: () => undefined },
    );
    await expect(manager.create({ worktreeId, profileId, url: "javascript:alert(1)" })).rejects.toThrow("browser URL");
    await expect(
      manager.setBounds("00000000-0000-4000-8000-000000000099", { x: 0, y: 0, width: 0, height: 400 }),
    ).rejects.toThrow("browser tab");
  });

  it("restores a durable tab id and reports lifecycle changes", async () => {
    const updates: string[] = [];
    const closes: string[] = [];
    const browserTabId = "00000000-0000-4000-8000-000000000003";
    const manager = new BrowserManager(
      { create: () => createFakeView("https://example.com") },
      { addChildView: () => undefined, removeChildView: () => undefined },
      {
        onProjection: (tab) => updates.push(tab.browserTabId),
        onClose: (tab) => closes.push(tab.browserTabId),
      },
    );

    const tab = await manager.create({ browserTabId, worktreeId, profileId, url: "https://example.com" });

    expect(tab.browserTabId).toBe(browserTabId);
    expect(updates).toContain(browserTabId);
    manager.close(browserTabId);
    expect(closes).toEqual([browserTabId]);

    const second = await manager.create({ browserTabId, worktreeId, profileId, url: "https://example.com" });
    expect(second.browserTabId).toBe(browserTabId);
    manager.closeAll({ persist: false });
    expect(closes).toEqual([browserTabId]);
  });

  it("recreates a crashed browser renderer from its durable tab metadata", async () => {
    const views: Array<ReturnType<typeof createFakeView>> = [];
    const host = { addChildView: () => undefined, removeChildView: () => undefined };
    const manager = new BrowserManager(
      {
        create: () => {
          const view = createFakeView("https://example.com");
          views.push(view);
          return view;
        },
      },
      host,
    );
    const tab = await manager.create({ worktreeId, profileId, url: "https://example.com" });
    await manager.activate(tab.browserTabId);

    views[0]?.emit("render-process-gone");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));

    expect(views).toHaveLength(2);
    expect(manager.list(worktreeId)[0]).toMatchObject({
      browserTabId: tab.browserTabId,
      status: "loading",
      active: true,
      url: "https://example.com",
    });
    expect(views[1]?.visible).toBe(true);

    views[0]?.emit("render-process-gone");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));
    expect(manager.list(worktreeId)[0]?.status).toBe("loading");
  });

  it("ignores subframe load failures when choosing a top-level recovery URL", async () => {
    const views: Array<ReturnType<typeof createFakeView>> = [];
    const manager = new BrowserManager(
      {
        create: () => {
          const view = createFakeView("https://example.com");
          views.push(view);
          return view;
        },
      },
      { addChildView: () => undefined, removeChildView: () => undefined },
    );
    await manager.create({ worktreeId, profileId, url: "https://example.com" });

    views[0]?.emit("did-fail-load", {}, -3, "ERR_ABORTED", "https://cdn.example/frame.html", false);

    expect(views).toHaveLength(1);
    expect(views[0]?.loadedUrls).toEqual(["https://example.com"]);
    expect(manager.list(worktreeId)[0]).toMatchObject({
      status: "loading",
      url: "https://example.com",
    });

    views[0]?.emit("render-process-gone");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));

    expect(views[1]?.loadedUrls).toEqual(["https://example.com"]);
    expect(manager.list(worktreeId)[0]).toMatchObject({
      status: "loading",
      url: "https://example.com",
    });
  });

  it("revalidates main-frame recovery and will not load a disallowed failed URL", async () => {
    const views: Array<ReturnType<typeof createFakeView>> = [];
    const manager = new BrowserManager(
      {
        create: () => {
          const view = createFakeView("https://example.com");
          views.push(view);
          return view;
        },
      },
      { addChildView: () => undefined, removeChildView: () => undefined },
    );
    await manager.create({ worktreeId, profileId, url: "https://example.com" });

    views[0]?.emit("did-fail-load", {}, -2, "ERR_FAILED", "javascript:alert(1)", true);
    views[0]?.emit("did-fail-load", {}, -2, "ERR_FAILED", "https://user:pass@example.com/secret", true);

    expect(manager.list(worktreeId)[0]).toMatchObject({
      status: "crashed",
      url: "https://example.com",
    });

    views[0]?.emit("render-process-gone");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));

    expect(views[1]?.loadedUrls).toEqual(["https://example.com"]);
    expect(manager.list(worktreeId)[0]).toMatchObject({
      status: "loading",
      url: "https://example.com",
    });
  });

  it("recovers an allowed main-frame failure through the shared navigation policy", async () => {
    const views: Array<ReturnType<typeof createFakeView>> = [];
    const manager = new BrowserManager(
      {
        create: () => {
          const view = createFakeView("https://example.com");
          views.push(view);
          return view;
        },
      },
      { addChildView: () => undefined, removeChildView: () => undefined },
    );
    await manager.create({ worktreeId, profileId, url: "https://example.com" });

    views[0]?.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "http://127.0.0.1:3000/app", true);
    expect(manager.list(worktreeId)[0]).toMatchObject({
      status: "crashed",
      url: "http://127.0.0.1:3000/app",
    });

    views[0]?.emit("render-process-gone");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));

    expect(views[1]?.loadedUrls).toEqual(["http://127.0.0.1:3000/app"]);
    expect(manager.list(worktreeId)[0]).toMatchObject({
      status: "loading",
      url: "http://127.0.0.1:3000/app",
    });
  });

  it("keeps a tab whose first load fails registered and reports the failure", async () => {
    const views: Array<ReturnType<typeof createFakeView>> = [];
    const removed: unknown[] = [];
    const manager = new BrowserManager(
      {
        create: () => {
          const view = createFakeView("about:blank");
          view.webContents.loadURL = async () => {
            throw Object.assign(new Error("ERR_CONNECTION_REFUSED (-102) loading 'http://127.0.0.1:5173/'"), {
              code: "ERR_CONNECTION_REFUSED",
              errno: -102,
            });
          };
          views.push(view);
          return view;
        },
      },
      { addChildView: () => undefined, removeChildView: (view) => removed.push(view) },
    );

    const tab = await manager.create({ worktreeId, profileId, url: "http://127.0.0.1:5173/" });

    expect(tab).toMatchObject({ status: "crashed", url: "http://127.0.0.1:5173/" });
    expect(tab.loadError).toContain("ERR_CONNECTION_REFUSED");
    expect(manager.list(worktreeId)).toHaveLength(1);
    await manager.activate(tab.browserTabId);
    expect(views[0]?.visible).toBe(true);
    manager.close(tab.browserTabId);
    expect(removed).toEqual([views[0]]);
    expect(manager.list(worktreeId)).toHaveLength(0);
  });

  it("ignores superseded loads and clears a load error once navigation succeeds", async () => {
    let failNext: "abort" | "refuse" | undefined = "abort";
    const manager = new BrowserManager(
      {
        create: () => {
          const view = createFakeView("about:blank");
          view.webContents.loadURL = async () => {
            const mode = failNext;
            failNext = undefined;
            if (mode === "abort")
              throw Object.assign(new Error("ERR_ABORTED (-3)"), { code: "ERR_ABORTED", errno: -3 });
            if (mode === "refuse") throw new Error("ERR_CONNECTION_REFUSED (-102)");
          };
          return view;
        },
      },
      { addChildView: () => undefined, removeChildView: () => undefined },
    );
    const tab = await manager.create({ worktreeId, profileId, url: "https://example.com" });
    expect(tab.status).toBe("loading");
    expect(tab.loadError).toBeUndefined();

    failNext = "refuse";
    const failed = await manager.navigate({ browserTabId: tab.browserTabId, url: "http://127.0.0.1:9/" });
    expect(failed).toMatchObject({ status: "crashed" });
    expect(failed.loadError).toContain("ERR_CONNECTION_REFUSED");

    const recovered = await manager.navigate({ browserTabId: tab.browserTabId, url: "https://example.org" });
    expect(recovered.loadError).toBeUndefined();
    expect("loadError" in recovered).toBe(false);
  });

  it("removes the native view when tab setup fails before registration", async () => {
    const view = createFakeView("https://example.com");
    let destroyed = false;
    view.webContents.destroy = () => {
      destroyed = true;
    };
    const removed: unknown[] = [];
    const manager = new BrowserManager(
      { create: () => view },
      { addChildView: () => undefined, removeChildView: (child) => removed.push(child) },
      {
        automationFactory: () => {
          throw new Error("debugger unavailable");
        },
      },
    );

    await expect(manager.create({ worktreeId, profileId, url: "https://example.com" })).rejects.toThrow(
      "debugger unavailable",
    );
    expect(removed).toEqual([view]);
    expect(destroyed).toBe(true);
    expect(manager.list()).toHaveLength(0);
  });

  it("hides every view on request and keeps them hidden until the renderer activates again", async () => {
    const views: Array<ReturnType<typeof createFakeView>> = [];
    const manager = new BrowserManager(
      {
        create: () => {
          const view = createFakeView("https://example.com");
          views.push(view);
          return view;
        },
      },
      { addChildView: () => undefined, removeChildView: () => undefined },
    );
    const tab = await manager.create({ worktreeId, profileId, url: "https://example.com" });
    await manager.activate(tab.browserTabId);
    expect(views[0]?.visible).toBe(true);

    manager.hide();
    expect(manager.hidden).toBe(true);
    expect(views[0]?.visible).toBe(false);
    expect(manager.list(worktreeId)[0]?.active).toBe(true);

    views[0]?.emit("render-process-gone");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));
    expect(views[1]?.visible).toBe(false);

    await manager.activate(tab.browserTabId);
    expect(manager.hidden).toBe(false);
    expect(views[1]?.visible).toBe(true);
  });
});

describe("BrowserManager device viewports and DevTools", () => {
  function managerWithAutomation(order: string[] = []) {
    const views: Array<ReturnType<typeof createFakeView>> = [];
    const emulations: unknown[] = [];
    const automation = {
      start: async () => {
        order.push("start");
      },
      emulate: async (emulation: unknown) => {
        emulations.push(emulation);
      },
      dispose: () => undefined,
    };
    const manager = new BrowserManager(
      {
        create: () => {
          const view = createFakeView("about:blank");
          const load = view.webContents.loadURL;
          view.webContents.loadURL = async (next: string) => {
            order.push(`load ${next}`);
            await load(next);
          };
          views.push(view);
          return view;
        },
      },
      { addChildView: () => undefined, removeChildView: () => undefined },
      {
        automationFactory: () => ({
          cdp: {} as never,
          automation: automation as unknown as BrowserAutomation,
          designMode: {} as never,
        }),
      },
    );
    return { manager, views, emulations };
  }

  it("starts automation after the first load so a fresh view cannot stall it", async () => {
    const order: string[] = [];
    const { manager } = managerWithAutomation(order);
    await manager.create({ worktreeId, profileId, url: "about:blank" });
    expect(order).toEqual(["load about:blank", "start"]);
  });

  it("fits a device viewport inside the pane surface and scales input with it", async () => {
    const { manager, views, emulations } = managerWithAutomation();
    const tab = await manager.create({ worktreeId, profileId, url: "about:blank" });
    await manager.setBounds(tab.browserTabId, { x: 100, y: 50, width: 700, height: 500 });
    expect(views[0]?.bounds).toEqual({ x: 100, y: 50, width: 700, height: 500 });

    const iphone = browserViewportForPreset("iphone-15");
    const projection = await manager.setViewport(tab.browserTabId, iphone);
    expect(projection.viewport).toEqual(iphone);
    expect(views[0]?.bounds).toEqual({ x: 335, y: 50, width: 230, height: 500 });
    expect(emulations).toHaveLength(1);
    expect(emulations[0]).toMatchObject({ width: 393, height: 852, mobile: true, deviceScaleFactor: 3 });
    expect((emulations[0] as { scale: number }).scale).toBeCloseTo(500 / 852);
    expect((emulations[0] as { userAgent: string }).userAgent).toContain("iPhone");

    // The same scale is not sent to Chromium again on every layout pass.
    await manager.setBounds(tab.browserTabId, { x: 100, y: 50, width: 700, height: 500 });
    expect(emulations).toHaveLength(1);
    await manager.setBounds(tab.browserTabId, { x: 0, y: 0, width: 1200, height: 1000 });
    expect(views[0]?.bounds).toEqual({ x: 403, y: 74, width: 393, height: 852 });
    expect(emulations.at(-1)).toMatchObject({ scale: 1 });

    const reset = await manager.setViewport(tab.browserTabId, null);
    expect(reset.viewport).toBeUndefined();
    expect(views[0]?.bounds).toEqual({ x: 0, y: 0, width: 1200, height: 1000 });
    expect(emulations.at(-1)).toBeNull();
  });

  it("rejects invalid viewports", async () => {
    const { manager } = managerWithAutomation();
    const tab = await manager.create({ worktreeId, profileId, url: "about:blank" });
    await expect(manager.setViewport(tab.browserTabId, { width: 0, height: 800, mobile: true })).rejects.toThrow();
  });

  it("places new tabs at the last pane surface the renderer reported", async () => {
    const { manager, views } = managerWithAutomation();
    const first = await manager.create({ worktreeId, profileId, url: "about:blank" });
    await manager.setBounds(first.browserTabId, { x: 10, y: 20, width: 600, height: 400 });
    await manager.create({ worktreeId, profileId, url: "about:blank" });
    expect(views[1]?.bounds).toEqual({ x: 10, y: 20, width: 600, height: 400 });
  });

  it("opens DevTools detached and focuses the existing window on a second request", async () => {
    const { manager, views } = managerWithAutomation();
    const tab = await manager.create({ worktreeId, profileId, url: "about:blank" });
    const contents = views[0]?.webContents as Record<string, unknown>;
    const opened: unknown[] = [];
    let focused = 0;
    let open = false;
    contents.openDevTools = (options: unknown) => {
      opened.push(options);
      open = true;
    };
    contents.isDevToolsOpened = () => open;
    contents.devToolsWebContents = {
      focus: () => {
        focused += 1;
      },
    };

    manager.openDevTools(tab.browserTabId);
    manager.openDevTools(tab.browserTabId);

    expect(opened).toEqual([{ mode: "detach", activate: true }]);
    expect(focused).toBe(1);
  });

  it("reports whether history navigation was possible", async () => {
    const { manager, views } = managerWithAutomation();
    const tab = await manager.create({ worktreeId, profileId, url: "about:blank" });
    expect(manager.back(tab.browserTabId)).toBe(false);
    expect(manager.forward(tab.browserTabId)).toBe(false);
    const contents = views[0]?.webContents as Record<string, unknown>;
    let wentBack = false;
    contents.canGoBack = () => true;
    contents.goBack = () => {
      wentBack = true;
    };
    expect(manager.back(tab.browserTabId)).toBe(true);
    expect(wentBack).toBe(true);
  });
});

describe("fitViewport and emulationFor", () => {
  it("never upscales and keeps the device aspect ratio", () => {
    expect(fitViewport({ x: 0, y: 0, width: 2000, height: 2000 }, { width: 400, height: 800 })).toEqual({
      bounds: { x: 800, y: 600, width: 400, height: 800 },
      scale: 1,
    });
    const fitted = fitViewport({ x: 0, y: 0, width: 200, height: 1000 }, { width: 400, height: 800 });
    expect(fitted.scale).toBe(0.5);
    expect(fitted.bounds).toEqual({ x: 0, y: 300, width: 200, height: 400 });
  });

  it("leaves the desktop user agent alone for non-mobile viewports", () => {
    expect(emulationFor({ width: 1280, height: 800, mobile: false }, 1)).toEqual({
      width: 1280,
      height: 800,
      mobile: false,
      scale: 1,
    });
    expect(emulationFor({ preset: "pixel-8", width: 412, height: 915, mobile: true }, 1).userAgent).toContain(
      "Android",
    );
  });
});

describe("toWindowPixels", () => {
  it("keeps bounds as they are at 100% zoom", () => {
    const bounds = { x: 630, y: 65, width: 300, height: 431 };
    expect(toWindowPixels(bounds, 1)).toBe(bounds);
  });

  it("scales the pane's CSS pixels to window pixels without opening a gap at the edges", () => {
    expect(toWindowPixels({ x: 630, y: 65, width: 301, height: 431 }, 1.1)).toEqual({
      x: 693,
      y: 72,
      width: 331,
      height: 474,
    });
    expect(toWindowPixels({ x: 100, y: 50, width: 400, height: 300 }, 0.9)).toEqual({
      x: 90,
      y: 45,
      width: 360,
      height: 270,
    });
  });
});

describe("BrowserManager zoom", () => {
  it("places the page on the pane when the window is zoomed, and again after the zoom changes", async () => {
    let zoom = 1.1;
    const view = createFakeView("https://example.com");
    const manager = new BrowserManager(
      { create: () => view },
      { addChildView: () => undefined, removeChildView: () => undefined },
      { zoomFactor: () => zoom },
    );
    const tab = await manager.create({ worktreeId, profileId, url: "https://example.com" });
    await manager.setBounds(tab.browserTabId, { x: 630, y: 65, width: 301, height: 431 });
    expect(view.bounds).toEqual({ x: 693, y: 72, width: 331, height: 474 });

    zoom = 1;
    await manager.relayout();
    expect(view.bounds).toEqual({ x: 630, y: 65, width: 301, height: 431 });
  });

  it("draws an emulated device at the window's zoom", async () => {
    const emulations: unknown[] = [];
    const view = createFakeView("https://example.com");
    const manager = new BrowserManager(
      { create: () => view },
      { addChildView: () => undefined, removeChildView: () => undefined },
      {
        zoomFactor: () => 1.25,
        automationFactory: () => ({
          cdp: {} as never,
          designMode: {} as never,
          automation: {
            start: async () => undefined,
            dispose: () => undefined,
            emulate: async (emulation: unknown) => {
              emulations.push(emulation);
            },
          } as unknown as BrowserAutomation,
        }),
      },
    );
    const tab = await manager.create({ worktreeId, profileId, url: "https://example.com" });
    await manager.setBounds(tab.browserTabId, { x: 0, y: 0, width: 800, height: 1000 });
    await manager.setViewport(tab.browserTabId, { width: 400, height: 800, mobile: true });
    expect(view.bounds).toEqual({ x: 250, y: 125, width: 500, height: 1000 });
    expect(emulations.at(-1)).toMatchObject({ width: 400, height: 800, scale: 1.25 });
  });
});
