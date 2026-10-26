// @vitest-environment jsdom

import { EnvironmentId, ProjectId, type RuntimeProjection, WorktreeId } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

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

async function mount(current: RuntimeProjection, onWorktreeAction = vi.fn()) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <Sidebar
        projection={current}
        sessions={[]}
        activeSessionId={undefined}
        backgroundSessionIds={new Set()}
        activeWorktreeId={undefined}
        onSelectSession={noop}
        onStopSession={noop}
        onDeleteSession={noop}
        onSelectWorktree={noop}
        onNewAgent={noop}
        onOpenProject={noop}
        onCreateWorktree={noop}
        onWorktreeAction={onWorktreeAction}
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

const has = (root: ParentNode, label: string) => {
  try {
    button(root, label);
    return true;
  } catch {
    return false;
  }
};

describe("Sidebar projects", () => {
  it("folds a project and remembers it after a restart", async () => {
    const current = projection([
      { worktreeId: checkoutId, projectId, path: "/work/repo", branch: "main", status: "ready", kind: "checkout" },
    ]);
    const first = await mount(current);
    const toggle = button(first.container, "repo, collapse");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(first.container.textContent).toContain("No agents yet.");
    expect(first.container.querySelector(".worktree-list")).not.toBeNull();

    await act(async () => toggle.click());
    expect(button(first.container, "repo, expand").getAttribute("aria-expanded")).toBe("false");
    expect(first.container.textContent).not.toContain("No agents yet.");
    expect(first.container.querySelector(".worktree-heading")).toBeNull();
    expect(first.container.querySelector(".project-summary")).toBeNull();
    await first.unmount();

    const again = await mount(current);
    expect(again.container.querySelector(".worktree-heading")).toBeNull();
    await act(async () => button(again.container, "repo, expand").click());
    expect(again.container.querySelector(".worktree-list")).not.toBeNull();
    expect(parseSidebarCollapsed(window.localStorage.getItem("zli.sidebar.collapsed")).projects).toEqual([]);
  });

  it("remembers a closed Worktrees list", async () => {
    const current = projection([
      { worktreeId: checkoutId, projectId, path: "/work/repo", branch: "main", status: "ready", kind: "checkout" },
    ]);
    const first = await mount(current);
    await act(async () => first.container.querySelector<HTMLButtonElement>(".worktree-toggle")?.click());
    expect(first.container.querySelector(".worktree-list")).toBeNull();
    await first.unmount();
    const again = await mount(current);
    expect(again.container.querySelector(".worktree-toggle")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("lets a stuck checkout be removed, but only cancels a worktree still being created", async () => {
    const onWorktreeAction = vi.fn<(worktree: { worktreeId: string }, action: WorktreeAction) => void>();
    const { container } = await mount(
      projection([
        { worktreeId: checkoutId, projectId, path: "/work/repo", branch: "HEAD", status: "queued", kind: "checkout" },
        { worktreeId: featureId, projectId, path: "/work/repo-feat", branch: "feat", status: "creating" },
      ]),
      onWorktreeAction,
    );
    const [checkoutRow, featureRow] = [...container.querySelectorAll<HTMLElement>(".worktree-entry")];
    expect(has(checkoutRow as HTMLElement, "Cancel")).toBe(true);
    expect(has(featureRow as HTMLElement, "Cancel")).toBe(true);
    expect(has(featureRow as HTMLElement, "Remove worktree")).toBe(false);

    await act(async () => button(checkoutRow as HTMLElement, "Remove worktree").click());
    await act(async () => button(checkoutRow as HTMLElement, "Forget checkout").click());
    expect(onWorktreeAction).toHaveBeenCalledWith(expect.objectContaining({ worktreeId: checkoutId }), "remove");
  });

  it("names a worktree delete as a worktree, not a checkout", async () => {
    const { container } = await mount(
      projection([{ worktreeId: featureId, projectId, path: "/work/repo-feat", branch: "feat", status: "ready" }]),
    );
    await act(async () => button(container, "Remove worktree").click());
    expect(has(container, "Delete worktree")).toBe(true);
    expect(has(container, "Delete checkout")).toBe(false);
  });
});

describe("parseSidebarCollapsed", () => {
  it("keeps only string ids and survives bad storage", () => {
    expect(parseSidebarCollapsed('{"projects":["a",1],"worktrees":"b"}')).toEqual({ projects: ["a"], worktrees: [] });
    expect(parseSidebarCollapsed("not json")).toEqual({ projects: [], worktrees: [] });
    expect(parseSidebarCollapsed(null)).toEqual({ projects: [], worktrees: [] });
  });
});
