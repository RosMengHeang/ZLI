import type { PullRequestInfo, ReviewProjection } from "@zli-v2/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { type LauncherState, launcherItems } from "./launcherItems.js";

const quiet: LauncherState = {
  mobileAvailable: false,
  showTerminal: true,
  drawerOpen: false,
  review: undefined,
  uncommittedFiles: undefined,
  runningTerminals: 0,
  devServers: [],
  pullRequest: undefined,
  activeHuddles: 0,
  sideChat: false,
};

const actions = () => ({ open: vi.fn(), openTerminal: vi.fn(), openDevServer: vi.fn() });
const text = (node: unknown) => renderToStaticMarkup(<>{node}</>).replace(/<[^>]+>/g, "");

describe("launcherItems", () => {
  it("lists the panels in a fixed order with their keys, and nothing live when nothing is going on", () => {
    const items = launcherItems(quiet, actions());
    expect(items.map((item) => `${item.label}:${item.hotkey}`)).toEqual([
      "Changes:c",
      "Files:f",
      "Terminal:t",
      "Browser:b",
      "Huddle:h",
    ]);
    expect(items.every((item) => item.live === undefined)).toBe(true);
  });

  it("says how much there is to review, or that the worktree is clean", () => {
    const review = {
      worktreeId: "w",
      state: "changes",
      files: [
        { path: "a.ts", kind: "modified", staged: false, additions: 10, deletions: 2, binary: false },
        { path: "b.ts", kind: "added", staged: false, additions: 3, deletions: 0, binary: false },
      ],
      conflictFiles: [],
    } as unknown as ReviewProjection;
    const changes = launcherItems({ ...quiet, review }, actions())[0];
    expect(changes?.live?.tone).toBe("accent");
    expect(text(changes?.live?.text)).toBe("2 files to review +13 −2");
    const clean = launcherItems({ ...quiet, review: { ...review, state: "clean", files: [] } }, actions())[0];
    expect(clean?.live).toEqual({ text: "Clean. Nothing to review", tone: "muted" });
  });

  it("opens a running dev server from the Browser row", () => {
    const run = actions();
    const browser = launcherItems({ ...quiet, devServers: [{ url: "http://localhost:5173/" }] }, run).find(
      (item) => item.id === "browser",
    );
    expect(browser?.live).toEqual({ text: "localhost:5173 is up. Open it", tone: "green" });
    browser?.run();
    expect(run.openDevServer).toHaveBeenCalledWith("http://localhost:5173/");
  });

  it("adds the pull request with its checks, red when one fails", () => {
    const pullRequest = {
      number: 12,
      url: "https://github.com/a/b/pull/12",
      state: "OPEN",
      isDraft: false,
      checks: [
        { name: "test", state: "failed" },
        { name: "lint", state: "passed" },
      ],
    } as PullRequestInfo;
    const row = launcherItems({ ...quiet, pullRequest }, actions()).find((item) => item.id === "pullRequest");
    expect(row?.hotkey).toBe("p");
    expect(row?.live).toEqual({ text: "#12 · 1 of 2 checks failed", tone: "red" });
  });

  it("adds the side chat when a chat is in view", () => {
    const run = actions();
    const row = launcherItems({ ...quiet, sideChat: true }, run).at(-1);
    expect(row?.label).toBe("Side chat");
    expect(row?.hotkey).toBe("s");
    row?.run();
    expect(run.open).toHaveBeenCalledWith("sideChat");
  });

  it("leaves the terminal out in Chat only", () => {
    const items = launcherItems({ ...quiet, showTerminal: false }, actions());
    expect(items.some((item) => item.id === "terminal")).toBe(false);
  });
});
