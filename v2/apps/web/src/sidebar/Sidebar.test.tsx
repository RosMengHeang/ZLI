// @vitest-environment jsdom

import { EnvironmentId, ProjectId, type RuntimeProjection, WorktreeId } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentSession } from "../sessions/sessions.js";
import { Sidebar, type WorktreeAction } from "./Sidebar.js";
import { parseSidebarCollapsed } from "./sidebarLayout.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
});

const projectId = ProjectId.parse("00000000-0000-4000-8000-000000000010");
const checkoutId = WorktreeId.parse("00000000-0000-4000-8000-000000000011");
const featureId = WorktreeId.parse("00000000-0000-4000-8000-000000000012");

function projection(worktrees: RuntimeProjection["worktrees"]): RuntimeProjection {
  return {
    environment: {
      environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000001"),
      label: "Local",
      protocolVersion: 1,
      capabilities: { worktrees: true, terminals: true, browser: true, eventReplay: true },
    },
    projects: [{ projectId, path: "/work/repo", name: "repo" }],
    worktrees,
    threads: [],
    terminals: [],
    browserTabs: [],
    attention: [],
    lastSequence: 1,
  };
}

const noop = () => undefined;

type MountOptions = {
  sessions?: AgentSession[];
  onStopSession?: (session: AgentSession) => void;
  onDeleteSession?: (session: AgentSession) => void;
  onWorktreeAction?: (worktree: { worktreeId: string }, action: WorktreeAction) => void;
  onCreateWorktree?: (project?: { projectId: string }) => void;
};

async function mount(current: RuntimeProjection, options: MountOptions = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <Sidebar
        projection={current}
        sessions={options.sessions ?? []}
        activeSessionId={undefined}
        backgroundSessionIds={new Set()}
        activeWorktreeId={undefined}
        onSelectSession={noop}
        onStopSession={options.onStopSession ?? noop}
        onDeleteSession={options.onDeleteSession ?? noop}
        onSelectWorktree={noop}
        onNewAgent={noop}
        onOpenProject={noop}
        onCreateWorktree={options.onCreateWorktree ?? noop}
        onWorktreeAction={options.onWorktreeAction ?? noop}
        onReviewSetup={noop}
        onShowSetupOutput={noop}
        onOpenHelp={noop}
        onOpenSettings={noop}
        onOpenUsage={noop}
        onHideSidebar={noop}
      />,
    );
  });
  return { container, unmount: () => act(async () => root.unmount()) };
}

function button(root: ParentNode, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`No button ${label}`);
  return found;
}

/** Opens a row's "..." menu and returns its item labels; the menu renders in a portal on the body. */
async function openMenu(root: ParentNode, label: string): Promise<string[]> {
  await act(async () => button(root, label).click());
  return [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((item) => item.textContent ?? "");
}

const has = (root: ParentNode, label: string) => {
  try {
    button(root, label);
    return true;
  } catch {
    return false;
  }
};

const agent = (worktreeId: string): AgentSession => ({
  sessionId: "session-1",
  worktreeId,
  provider: "claude",
  status: "working",
  mode: "terminal",
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
});

describe("Sidebar projects", () => {
  it("folds a project and remembers it after a restart", async () => {
    const current = projection([
      { worktreeId: checkoutId, projectId, path: "/work/repo", branch: "main", status: "ready", kind: "checkout" },
    ]);
    const first = await mount(current);
    const toggle = button(first.container, "repo, collapse");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(first.container.textContent).toContain("No agents yet.");
    expect(first.container.querySelector(".worktree-heading")).not.toBeNull();

    await act(async () => toggle.click());
    expect(button(first.container, "repo, expand").getAttribute("aria-expanded")).toBe("false");
    expect(first.container.textContent).not.toContain("No agents yet.");
    expect(first.container.querySelector(".worktree-heading")).toBeNull();
    expect(first.container.querySelector(".project-summary")).toBeNull();
    await first.unmount();

    const again = await mount(current);
    expect(again.container.querySelector(".worktree-heading")).toBeNull();
    await act(async () => button(again.container, "repo, expand").click());
    expect(again.container.querySelector(".worktree-heading")).not.toBeNull();
    expect(parseSidebarCollapsed(window.localStorage.getItem("zli.sidebar.collapsed")).projects).toEqual([]);
  });

  it("folds worktrees without agents into one row and remembers when it is opened", async () => {
    const current = projection([
      { worktreeId: checkoutId, projectId, path: "/work/repo", branch: "main", status: "ready", kind: "checkout" },
      { worktreeId: featureId, projectId, path: "/work/repo-feat", branch: "feat", status: "ready" },
    ]);
    const first = await mount(current);
    const toggle = first.container.querySelector<HTMLButtonElement>(".worktree-toggle");
    expect(toggle?.textContent).toBe("2 worktrees without agents");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(first.container.querySelector(".worktree-list")).toBeNull();

    await act(async () => toggle?.click());
    expect(first.container.querySelectorAll(".worktree-row")).toHaveLength(2);
    await first.unmount();

    const again = await mount(current);
    expect(again.container.querySelector(".worktree-toggle")?.getAttribute("aria-expanded")).toBe("true");
    expect(again.container.querySelectorAll(".worktree-row")).toHaveLength(2);
  });

  it("shows the branch under the agent working on it instead of a worktree row", async () => {
    const { container } = await mount(
      projection([
        { worktreeId: checkoutId, projectId, path: "/work/repo", branch: "main", status: "ready", kind: "checkout" },
        { worktreeId: featureId, projectId, path: "/work/repo-feat", branch: "feat/login", status: "ready" },
      ]),
      { sessions: [agent(featureId)] },
    );
    const row = container.querySelector(".session-row");
    expect(row?.classList.contains("has-branch")).toBe(true);
    expect(row?.querySelector(".session-branch .worktree-name")?.textContent).toBe("feat/login");
    expect(row?.querySelector(".session-branch .worktree-status")).toBeNull();
    expect(container.querySelector(".worktree-toggle")?.textContent).toBe("1 worktree without agents");
    expect(container.querySelector(".worktree-row")).toBeNull();
  });

  it("puts the fix for a failed worktree under its agent", async () => {
    const onWorktreeAction = vi.fn<(worktree: { worktreeId: string }, action: WorktreeAction) => void>();
    const { container } = await mount(
      projection([
        {
          worktreeId: featureId,
          projectId,
          path: "/work/repo-feat",
          branch: "feat",
          status: "failed",
          errorMessage: "Branch already exists.",
        },
      ]),
      { sessions: [agent(featureId)], onWorktreeAction },
    );
    const entry = container.querySelector(".session-entry") as HTMLElement;
    expect(entry.querySelector(".session-branch .worktree-status")?.textContent).toBe("Failed");
    expect(entry.textContent).toContain("Branch already exists.");
    await act(async () => button(entry, "Retry").click());
    expect(onWorktreeAction).toHaveBeenCalledWith(expect.objectContaining({ worktreeId: featureId }), "retry");
    expect(container.querySelector(".worktree-row")).toBeNull();
  });

  it("creates a worktree from the project row", async () => {
    const onCreateWorktree = vi.fn();
    const { container } = await mount(projection([]), { onCreateWorktree });
    await act(async () => button(container, "Create worktree").click());
    expect(onCreateWorktree).toHaveBeenCalledWith(expect.objectContaining({ projectId }));
  });

  it("keeps an agent's stop and delete in its ... menu", async () => {
    const onStopSession = vi.fn();
    const onDeleteSession = vi.fn();
    const session: AgentSession = {
      ...agent(featureId),
      terminal: {
        terminalId: "terminal-1",
        worktreeId: featureId,
        title: "Codex",
        status: "running",
      } as unknown as NonNullable<AgentSession["terminal"]>,
    };
    const { container } = await mount(
      projection([{ worktreeId: featureId, projectId, path: "/work/repo-feat", branch: "feat", status: "ready" }]),
      { sessions: [session], onStopSession, onDeleteSession },
    );
    expect(container.querySelector(".session-entry [data-tooltip='Stop agent']")).toBeNull();
    const menuButton = container.querySelector<HTMLButtonElement>(".session-entry .row-more button");
    expect(menuButton?.getAttribute("aria-haspopup")).toBe("menu");
    await act(async () => menuButton?.click());
    const items = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((item) => item.textContent);
    expect(items).toContain("Delete agent");
    await act(async () => button(document.body, "Delete agent").click());
    expect(onDeleteSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-1" }));
  });

  it("lets a stuck checkout be removed, but only cancels a worktree still being created", async () => {
    const onWorktreeAction = vi.fn<(worktree: { worktreeId: string }, action: WorktreeAction) => void>();
    const { container } = await mount(
      projection([
        { worktreeId: checkoutId, projectId, path: "/work/repo", branch: "HEAD", status: "queued", kind: "checkout" },
        { worktreeId: featureId, projectId, path: "/work/repo-feat", branch: "feat", status: "creating" },
      ]),
      { onWorktreeAction },
    );
    expect(await openMenu(container, "feat actions")).toEqual(["Cancel"]);
    await act(async () => button(container, "feat actions").click());
    expect(await openMenu(container, "HEAD actions")).toEqual(["Cancel", "Forget checkout"]);
    await act(async () => button(document.body, "Forget checkout").click());
    await act(async () => button(container, "Forget checkout").click());
    expect(onWorktreeAction).toHaveBeenCalledWith(expect.objectContaining({ worktreeId: checkoutId }), "remove");
  });

  it("names a worktree delete as a worktree, not a checkout", async () => {
    const { container } = await mount(
      projection([{ worktreeId: featureId, projectId, path: "/work/repo-feat", branch: "feat", status: "ready" }]),
    );
    await act(async () => container.querySelector<HTMLButtonElement>(".worktree-toggle")?.click());
    expect(await openMenu(container, "feat actions")).toEqual(["Delete worktree"]);
    await act(async () => button(document.body, "Delete worktree").click());
    expect(has(container, "Delete worktree")).toBe(true);
    expect(has(container, "Keep")).toBe(true);
    expect(has(container, "Forget checkout")).toBe(false);
  });
});
describe("parseSidebarCollapsed", () => {
  it("keeps only string ids and survives bad storage", () => {
    expect(parseSidebarCollapsed('{"projects":["a",1],"idle":"b"}')).toEqual({ projects: ["a"], idle: [] });
    expect(parseSidebarCollapsed("not json")).toEqual({ projects: [], idle: [] });
    expect(parseSidebarCollapsed(null)).toEqual({ projects: [], idle: [] });
  });
});
