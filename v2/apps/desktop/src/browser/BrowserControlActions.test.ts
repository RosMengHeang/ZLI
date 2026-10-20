import { describe, expect, it } from "vitest";

import {
  BrowserControlError,
  createBrowserControlActions,
  DEFAULT_BROWSER_PROFILE_ID,
  type BrowserControlManager,
  normalizeAgentUrl,
  normalizeWorktreePath,
  resolveBrowserControlWorktree,
} from "./BrowserControlActions.js";

const MAIN = "00000000-0000-4000-8000-00000000000a";
const FEATURE = "00000000-0000-4000-8000-00000000000b";
const OTHER = "00000000-0000-4000-8000-00000000000c";

const worktrees = [
  { worktreeId: MAIN, path: "C:\\work\\repo", status: "ready" },
  { worktreeId: FEATURE, path: "C:\\work\\repo\\.worktrees\\feature", status: "ready" },
  { worktreeId: OTHER, path: "C:\\work\\other", status: "creating" },
];

describe("resolveBrowserControlWorktree", () => {
  it("picks the deepest ready worktree containing cwd, ignoring case and slashes on Windows", () => {
    expect(resolveBrowserControlWorktree({ cwd: "c:/WORK/repo/src" }, worktrees, "win32").worktreeId).toBe(MAIN);
    expect(
      resolveBrowserControlWorktree({ cwd: "C:\\work\\repo\\.worktrees\\feature\\app" }, worktrees, "win32").worktreeId,
    ).toBe(FEATURE);
    expect(resolveBrowserControlWorktree({ cwd: "/c/work/repo" }, worktrees, "win32").worktreeId).toBe(MAIN);
  });

  it("does not match sibling directories that share a prefix or worktrees that are not ready", () => {
    expect(() => resolveBrowserControlWorktree({ cwd: "C:\\work\\repository" }, worktrees, "win32")).toThrow(
      "Could not tell which ZLI worktree",
    );
    expect(() => resolveBrowserControlWorktree({ cwd: "C:\\work\\other" }, worktrees, "win32")).toThrow(
      BrowserControlError,
    );
  });

  it("prefers an explicit id, then the agent's worktree id, then cwd", () => {
    expect(
      resolveBrowserControlWorktree({ worktreeId: FEATURE, cwd: "C:\\work\\repo" }, worktrees, "win32").worktreeId,
    ).toBe(FEATURE);
    expect(() => resolveBrowserControlWorktree({ worktreeId: OTHER }, worktrees, "win32")).toThrow("no ready worktree");
    expect(
      resolveBrowserControlWorktree({ defaultWorktreeId: FEATURE, cwd: "C:\\work\\repo" }, worktrees, "win32")
        .worktreeId,
    ).toBe(FEATURE);
    expect(
      resolveBrowserControlWorktree({ defaultWorktreeId: OTHER, cwd: "C:\\work\\repo" }, worktrees, "win32").worktreeId,
    ).toBe(MAIN);
  });

  it("keeps paths case-sensitive on POSIX", () => {
    const posixWorktrees = [{ worktreeId: MAIN, path: "/home/me/Repo", status: "ready" }];
    expect(resolveBrowserControlWorktree({ cwd: "/home/me/Repo/web" }, posixWorktrees, "linux").worktreeId).toBe(MAIN);
    expect(() => resolveBrowserControlWorktree({ cwd: "/home/me/repo" }, posixWorktrees, "linux")).toThrow();
    expect(normalizeWorktreePath("/home/me/Repo/", "linux")).toBe("/home/me/Repo");
    expect(normalizeWorktreePath("C:\\", "win32")).toBe("c:/");
  });
});

describe("normalizeAgentUrl", () => {
  it("adds http:// to bare hosts and refuses non-web schemes", () => {
    expect(normalizeAgentUrl("localhost:5173/app")).toBe("http://localhost:5173/app");
    expect(normalizeAgentUrl(" https://example.com ")).toBe("https://example.com");
    expect(normalizeAgentUrl("about:blank")).toBe("about:blank");
    expect(() => normalizeAgentUrl("file:///C:/secrets.txt")).toThrow("Only http(s)");
    expect(() => normalizeAgentUrl("javascript:alert(1)")).toThrow("Only http(s)");
  });
});

type FakeTab = {
  browserTabId: string;
  worktreeId: string;
  profileId: string;
  url: string;
  title: string;
  active: boolean;
  status: "idle" | "loading" | "crashed";
};

function fakeManager() {
  const tabs: FakeTab[] = [];
  const calls: string[] = [];
  let next = 1;
  const manager = {
    list: (worktreeId?: string) => tabs.filter((tab) => worktreeId === undefined || tab.worktreeId === worktreeId),
    create: async (input: { worktreeId: string; profileId: string; url: string }) => {
      const tab: FakeTab = {
        browserTabId: `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`,
        ...input,
        title: "",
        active: false,
        status: "idle",
      };
      tabs.push(tab);
      calls.push(`create ${input.url} ${input.profileId}`);
      return tab;
    },
    navigate: async (input: { browserTabId: string; url: string }) => {
      const tab = tabs.find((candidate) => candidate.browserTabId === input.browserTabId);
      if (tab) {
        tab.url = input.url;
        tab.title = "Loaded";
      }
      calls.push(`navigate ${input.url}`);
      return tab;
    },
    back: () => false,
    forward: () => false,
    reload: () => undefined,
    close: (browserTabId: string) => {
      tabs.splice(
        tabs.findIndex((tab) => tab.browserTabId === browserTabId),
        1,
      );
    },
    snapshot: async (browserTabId: string) => ({ url: "x", title: "t", interactiveElements: [], tab: browserTabId }),
    screenshot: async () => ({
      mimeType: "image/png",
      // A 1x2 PNG header is enough for the size probe.
      data: Buffer.concat([
        Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
        Buffer.from([0, 0, 0, 1, 0, 0, 0, 2]),
        Buffer.alloc(8),
      ]).toString("base64"),
    }),
    setViewport: async (browserTabId: string, viewport: unknown) => {
      calls.push(`viewport ${JSON.stringify(viewport)}`);
      return { ...tabs.find((tab) => tab.browserTabId === browserTabId), ...(viewport ? { viewport } : {}) };
    },
    consoleMessages: () => [],
    clearConsole: () => undefined,
    networkRequests: () => [],
  };
  return { manager: manager as unknown as BrowserControlManager, tabs, calls };
}

describe("createBrowserControlActions", () => {
  const setup = (managerAvailable = true) => {
    const fake = fakeManager();
    const reveals: unknown[] = [];
    const dispatch = createBrowserControlActions({
      manager: () => (managerAvailable ? fake.manager : undefined),
      worktrees: () => worktrees,
      reveal: (event) => reveals.push(event),
      platform: "win32",
    });
    return { ...fake, reveals, dispatch };
  };

  it("opens agent pages in a reused default-profile tab and reveals it", async () => {
    const { dispatch, calls, reveals, tabs } = setup();
    const opened = (await dispatch("open", { url: "localhost:3000", cwd: "C:\\work\\repo" })) as {
      tab: { browserTabId: string; agentOpened: boolean; url: string };
      loaded: boolean;
    };
    expect(opened.loaded).toBe(true);
    expect(opened.tab).toMatchObject({ agentOpened: true, url: "http://localhost:3000" });
    expect(calls).toEqual([`create about:blank ${DEFAULT_BROWSER_PROFILE_ID}`, "navigate http://localhost:3000"]);
    expect(reveals).toEqual([{ browserTabId: opened.tab.browserTabId, worktreeId: MAIN }]);

    await dispatch("open", { url: "http://localhost:3000/about", cwd: "C:\\work\\repo" });
    expect(tabs).toHaveLength(1);
    await dispatch("open", { url: "http://localhost:3000/new", cwd: "C:\\work\\repo", newTab: true });
    expect(tabs).toHaveLength(2);
  });

  it("targets the tab the agent used last and reports when a worktree has none", async () => {
    const { dispatch, tabs } = setup();
    await expect(dispatch("snapshot", { cwd: "C:\\work\\repo" })).rejects.toThrow("No browser tab is open");
    await dispatch("open", { url: "http://localhost:1/", cwd: "C:\\work\\repo" });
    const snapshot = (await dispatch("snapshot", { cwd: "C:\\work\\repo\\src" })) as { browserTabId: string };
    expect(snapshot.browserTabId).toBe(tabs[0]?.browserTabId);
    await expect(dispatch("snapshot", { cwd: "C:\\work\\repo\\.worktrees\\feature" })).rejects.toThrow(
      "No browser tab is open",
    );
  });

  it("resolves viewport presets and reports PNG dimensions for screenshots", async () => {
    const { dispatch, calls } = setup();
    await dispatch("open", { url: "http://localhost:1/", cwd: "C:\\work\\repo" });
    await dispatch("viewport", { preset: "iphone-15", cwd: "C:\\work\\repo" });
    expect(calls.at(-1)).toContain('"width":393');
    await dispatch("viewport", { reset: true, cwd: "C:\\work\\repo" });
    expect(calls.at(-1)).toBe("viewport null");
    await expect(dispatch("viewport", { preset: "nokia", cwd: "C:\\work\\repo" })).rejects.toThrow(
      "Unknown device preset",
    );
    const shot = (await dispatch("screenshot", { cwd: "C:\\work\\repo" })) as { width: number; height: number };
    expect(shot).toMatchObject({ width: 1, height: 2 });
  });

  it("reports history limits, unknown actions, and a browser that is still starting", async () => {
    const { dispatch } = setup();
    await dispatch("open", { url: "http://localhost:1/", cwd: "C:\\work\\repo" });
    await expect(dispatch("back", { cwd: "C:\\work\\repo" })).rejects.toThrow("no earlier page");
    await expect(dispatch("teleport", {})).rejects.toMatchObject({ status: 404 });
    await expect(setup(false).dispatch("tabs", { cwd: "C:\\work\\repo" })).rejects.toMatchObject({ status: 503 });
  });
});
