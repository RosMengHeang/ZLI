// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { OverviewCards, type OverviewData } from "./OverviewCards.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  window.localStorage.clear();
});

const dispatched: unknown[] = [];
const bridge = {
  runtime: {
    dispatch: async (request: { command: unknown }) => {
      dispatched.push(request.command);
      return { accepted: true, result: {} };
    },
    getProjection: async () => undefined,
    onProjection: () => () => undefined,
  },
} as unknown as ZliBridge;

async function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<RuntimeProvider bridge={bridge}>{node}</RuntimeProvider>));
  return container;
}

const full: OverviewData = {
  environment: {
    place: "worktree",
    branch: "feat/panel",
    path: "/work/zli/panel",
    project: "zli",
    agent: "Claude Code",
    model: "Opus",
    account: "Work",
    startedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    status: { label: "Idle", tone: "muted" },
  },
  changes: {
    pullRequest: {
      number: 1988,
      title: "Redesign the right panel",
      url: "https://github.com/o/r/pull/1988",
      state: "CLOSED",
      isDraft: false,
      additions: 190788,
      deletions: 35294,
      changedFiles: 2218,
    },
    local: { files: 3, additions: 12, deletions: 4 },
  },
  checks: {
    count: "7/7",
    headline: "7/7 passed",
    tone: "passed",
    checks: Array.from({ length: 7 }, (_, index) => ({ name: `check ${index}`, state: "passed" as const })),
  },
  context: { tokens: 80_100, window: 1_000_000 },
  tokens: {
    total: 1000,
    rows: [
      { id: "cached", label: "Cache read", tokens: 800, share: 0.8 },
      { id: "uncached", label: "Uncached input", tokens: 100, share: 0.1 },
      { id: "output", label: "Output", tokens: 100, share: 0.1 },
    ],
  },
  compact: { status: "ready", run: vi.fn() },
  mcps: [{ server: "github", calls: 1, failed: 0 }],
  running: [
    {
      id: "terminal:t1:5173",
      icon: "globe",
      name: "localhost:5173",
      detail: "npm run dev",
      url: "http://localhost:5173/",
      status: "running",
      terminalId: "t1",
    },
    { id: "agent:3000", icon: "globe", name: "localhost:3000", url: "http://localhost:3000/", status: "running" },
    { id: "step:a1", icon: "monitor", name: "npm run electron", status: "running" },
    { id: "step:a0", icon: "terminal", name: "npm run build", status: "exited" },
  ],
};

const noop = () => undefined;

describe("OverviewCards", () => {
  it("shows a card for each part with data, with the reference's numbers", async () => {
    const container = await render(<OverviewCards data={full} onOpen={noop} />);
    const titles = [...container.querySelectorAll(".ov-card h3")].map((node) => node.textContent);
    // What runs for the chat sits in Environment's list, under the folder and the Git actions.
    expect(titles).toEqual(["Environment", "Changes", "Checks", "Context", "MCPs"]);
    const text = container.textContent ?? "";
    // Environment says where the chat runs. The agent and when it started are in the composer, not repeated here.
    const environment = container.querySelector('[aria-label="Environment"]')?.textContent ?? "";
    expect(environment).toContain("Worktree");
    expect(text).not.toContain("Claude Code · Opus");
    expect(text).not.toContain("Started 3d ago");
    expect(text).not.toContain("Runs in");
    expect(container.querySelector('[aria-label="Environment"] dt')).toBeNull();
    expect(text).toContain("Closed");
    expect(text).toContain("#1988");
    expect(text).toContain(`+${(190788).toLocaleString()}`);
    expect(text).toContain("3 files not committed");
    expect(text).toContain("Checks7/7");
    expect(text).toContain("Show 2 more checks");
    expect(text).toContain("8% used");
    expect(text).toContain("80k / 1M");
    expect(text).toContain("Cache read");
    expect(text).toContain("1 call");
  });

  it("hides every card nothing reports", async () => {
    const container = await render(<OverviewCards data={{ mcps: [], running: [] }} onOpen={noop} />);
    expect(container.querySelectorAll(".ov-card")).toHaveLength(0);
  });

  it("lists what runs with a status mark, opens addresses, and stops only what ZLI runs", async () => {
    const onOpenUrl = vi.fn();
    dispatched.length = 0;
    const container = await render(<OverviewCards data={full} onOpen={noop} onOpenUrl={onOpenUrl} />);
    const card = container.querySelector('[aria-label="Environment"]');
    const rows = [...(card?.querySelectorAll(".ov-run") ?? [])];
    expect(rows.map((row) => row.querySelector(".ov-row-name")?.textContent)).toEqual([
      "localhost:5173",
      "localhost:3000",
      "npm run electron",
      "npm run build",
    ]);
    expect(rows.map((row) => row.querySelector(".ov-dot")?.getAttribute("aria-label"))).toEqual([
      "Running",
      "Running",
      "Running",
      "Exited",
    ]);
    // Only the terminal's server has Stop; the agent owns the others.
    expect(rows.map((row) => row.querySelector(".btn")?.textContent ?? null)).toEqual(["Stop", null, null, null]);
    await act(async () => rows[1]?.querySelector<HTMLButtonElement>("button.ov-row")?.click());
    expect(onOpenUrl).toHaveBeenCalledWith("http://localhost:3000/");
    expect(rows[2]?.querySelector("button.ov-row")).toBeNull();
    await act(async () => rows[0]?.querySelector<HTMLButtonElement>(".btn")?.click());
    expect(dispatched).toContainEqual({ type: "terminal.stop", terminalId: "t1" });
  });

  it("compacts from the context card, opens panels from rows, and remembers a folded card", async () => {
    const onOpen = vi.fn();
    const container = await render(<OverviewCards data={full} onOpen={onOpen} />);
    const button = (label: string) =>
      [...container.querySelectorAll("button")].find((node) => node.textContent?.includes(label)) as HTMLButtonElement;
    await act(async () => button("Compact now").click());
    expect(full.compact?.run).toHaveBeenCalled();
    await act(async () => button("Redesign the right panel").click());
    expect(onOpen).toHaveBeenCalledWith("pullRequest");
    await act(async () => button("files not committed").click());
    expect(onOpen).toHaveBeenCalledWith("review");

    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Checks"] .ov-card-toggle');
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    await act(async () => toggle?.click());
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(JSON.parse(window.localStorage.getItem("zli.overview.collapsed") ?? "[]")).toEqual(["checks"]);
  });
});
