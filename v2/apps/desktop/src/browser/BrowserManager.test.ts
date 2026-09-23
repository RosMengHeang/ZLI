import { describe, expect, it } from "vitest";

import { BrowserManager, type BrowserViewFactory } from "./BrowserManager.js";

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
});
