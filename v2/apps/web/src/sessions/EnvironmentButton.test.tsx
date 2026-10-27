// @vitest-environment jsdom

import type { GitBranchesResult, ReviewProjection } from "@zli-v2/contracts";
import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resetPullRequestStoreForTests } from "../review/pullRequestStore.js";
import { buttonByLabel, cleanupRuntimeRenders, renderWithRuntime, worktree } from "../review/testRuntime.js";
import { commitPlan, EnvironmentButton, shortPath } from "./EnvironmentButton.js";

const BRANCHES: GitBranchesResult = {
  current: "feature",
  defaultBranch: "main",
  local: ["feature", "main"],
  remote: ["feature", "main"],
  details: { feature: { upstream: { name: "origin/feature", ahead: 0, behind: 0 } } },
};

const file = (path: string, staged: boolean, unstaged: boolean, additions = 3, deletions = 1) => ({
  path,
  kind: "modified" as const,
  staged,
  unstaged,
  additions,
  deletions,
  binary: false,
});

function review(files: ReviewProjection["files"], change: Partial<ReviewProjection> = {}): ReviewProjection {
  return {
    worktreeId: worktree.worktreeId,
    baseRef: "HEAD",
    branch: "feature",
    state: files.length > 0 ? "changes" : "clean",
    files,
    conflictFiles: [],
    updatedAt: "2026-01-01T10:00:00.000Z",
    ...change,
  };
}

let setReview: (next: ReviewProjection | undefined) => void = () => undefined;

function Harness({
  initial,
  noGit = false,
  onOpenChanges = () => undefined,
}: {
  initial: ReviewProjection | undefined;
  noGit?: boolean;
  onOpenChanges?: () => void;
}) {
  const [current, set] = useState(initial);
  setReview = set;
  return <EnvironmentButton worktree={worktree} review={current} noGit={noGit} onOpenChanges={onOpenChanges} />;
}

const popover = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Environment"]');
const inPopover = (text: string) =>
  [...(popover()?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.includes(text));

async function open() {
  await act(async () => {
    buttonByLabel("Environment")?.click();
  });
}

afterEach(async () => {
  await cleanupRuntimeRenders();
  resetPullRequestStoreForTests();
});

describe("commitPlan", () => {
  it("commits and pushes changes, pushes waiting commits, and says why when there is nothing to do", () => {
    expect(commitPlan(undefined, BRANCHES)).toMatchObject({ kind: "none", reason: "Reading the changes." });
    expect(commitPlan(review([file("a.ts", false, true)]), BRANCHES)).toEqual({
      kind: "commit",
      push: true,
      staged: false,
    });
    expect(
      commitPlan(review([file("a.ts", true, false)]), { ...BRANCHES, remote: [], defaultBranch: undefined }),
    ).toEqual({ kind: "commit", push: false, staged: true });
    expect(commitPlan(review([file("a.ts", false, true)], { state: "conflicted" }), BRANCHES)).toMatchObject({
      kind: "none",
    });
    expect(commitPlan(review([]), BRANCHES)).toEqual({ kind: "none", reason: "No changes to commit.", push: true });
    const ahead = { ...BRANCHES, details: { feature: { upstream: { name: "origin/feature", ahead: 2, behind: 0 } } } };
    expect(commitPlan(review([]), ahead)).toMatchObject({
      kind: "push",
      reason: "2 commits to push against origin/feature.",
    });
    const unpublished = { ...BRANCHES, current: "fix", local: ["fix", "main"], details: {} };
    expect(commitPlan(review([]), unpublished)).toEqual({ kind: "push", reason: "fix is not on origin yet." });
    // Committed changes against another base leave nothing to commit.
    expect(commitPlan(review([file("a.ts", false, false)], { baseRef: "main" }), BRANCHES).kind).toBe("none");
  });
});

describe("shortPath", () => {
  it("keeps the end of a long path", () => {
    expect(shortPath("C:/app")).toBe("C:/app");
    expect(shortPath("C:\\Users\\dev\\AppData\\Local\\Temp\\zli-v2-e2e-abc\\worktrees\\codex-xg5g", 30)).toBe(
      "…\\worktrees\\codex-xg5g",
    );
    expect(shortPath("/home/dev/a-very-long-folder-name-that-goes-on-and-on", 20).length).toBeLessThanOrEqual(20);
  });
});

describe("EnvironmentButton", () => {
  it("reads the changes when opened, then shows the folder, totals, and branch", async () => {
    const opened = vi.fn();
    const commands = await renderWithRuntime(<Harness initial={undefined} onOpenChanges={opened} />, (command) =>
      command.type === "review.git.branches" ? { result: BRANCHES } : { result: {} },
    );
    await open();
    expect(commands).toContainEqual({ type: "review.refresh", worktreeId: worktree.worktreeId, baseRef: "HEAD" });
    expect(inPopover("Changes")?.textContent).toContain("Reading");
    expect(popover()?.textContent).toContain("Local");
    expect(popover()?.textContent).toContain("C:/app");
    await act(async () => setReview(review([file("a.ts", false, true, 1200, 4), file("b.ts", false, true, 30, 0)])));
    expect(inPopover("Changes")?.textContent).toBe("Changes+1,230−4");
    expect(buttonByLabel("Branch feature")).toBeDefined();
    expect(inPopover("Commit and push")?.disabled).toBe(true);
    expect(popover()?.textContent).toContain(
      "Commits every change, new files included, then pushes the branch to origin.",
    );
    await act(async () => {
      inPopover("Changes")?.click();
    });
    expect(opened).toHaveBeenCalledOnce();
    expect(popover()).toBeNull();
  });

  it("commits, waits for Git's answer, then pushes", async () => {
    const commands = await renderWithRuntime(<Harness initial={review([file("a.ts", false, true)])} />, (command) =>
      command.type === "review.git.branches"
        ? { result: BRANCHES }
        : command.type === "review.pr.push"
          ? { result: { branch: "feature", remote: "origin" } }
          : { result: {} },
    );
    await open();
    const input = popover()?.querySelector<HTMLInputElement>('input[aria-label="Commit message"]');
    if (!input) throw new Error("no commit field");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "Fix the form");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      inPopover("Commit and push")?.click();
    });
    expect(commands).toContainEqual({
      type: "review.commit",
      worktreeId: worktree.worktreeId,
      message: "Fix the form",
    });
    expect(commands.some((command) => command.type === "review.pr.push")).toBe(false);
    expect(inPopover("Committing")).toBeDefined();
    await act(async () => setReview(review([], { updatedAt: "2026-01-01T10:01:00.000Z" })));
    await vi.waitFor(() => expect(popover()?.textContent).toContain("Committed and pushed feature to origin."));
    expect(commands.some((command) => command.type === "review.pr.push")).toBe(true);
  });

  it("shows Git's error and does not push when the commit fails", async () => {
    const commands = await renderWithRuntime(<Harness initial={review([file("a.ts", true, false)])} />, (command) =>
      command.type === "review.git.branches" ? { result: BRANCHES } : { result: {} },
    );
    await open();
    const input = popover()?.querySelector<HTMLInputElement>('input[aria-label="Commit message"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "Fix");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(popover()?.textContent).toContain("Commits only the staged changes");
    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await act(async () =>
      setReview(
        review([file("a.ts", true, false)], { updatedAt: "2026-01-01T10:01:00.000Z", errorMessage: "hook failed" }),
      ),
    );
    expect(popover()?.querySelector('[role="alert"]')?.textContent).toBe("hook failed");
    expect(commands.some((command) => command.type === "review.pr.push")).toBe(false);
  });

  it("shows only the folder for a project without Git, and closes on Escape", async () => {
    const commands = await renderWithRuntime(<Harness initial={undefined} noGit />, () => ({ result: {} }));
    await open();
    expect(popover()?.textContent).toContain("not a Git repository");
    expect(inPopover("Changes")).toBeUndefined();
    expect(commands).toEqual([]);
    await act(async () => {
      popover()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(buttonByLabel("Environment"));
  });
});
