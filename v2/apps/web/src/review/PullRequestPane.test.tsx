// @vitest-environment jsdom

import type { RuntimeProjection } from "@zli-v2/contracts";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PullRequestPane } from "./PullRequestPane.js";
import { resetPullRequestStoreForTests } from "./pullRequestStore.js";
import { buttonByLabel, buttonByText, cleanupRuntimeRenders, renderWithRuntime, worktree } from "./testRuntime.js";

afterEach(async () => {
  await cleanupRuntimeRenders();
  resetPullRequestStoreForTests();
});

const status = (pullRequest?: Record<string, unknown>) => ({
  branch: "feature",
  uncommittedFiles: 0,
  defaults: { title: "", body: "", base: "main" },
  ...(pullRequest ? { pullRequest } : {}),
});

describe("PullRequestPane", () => {
  it("shows the pull request: title, byline, size, description, checks, and Merge", async () => {
    await renderWithRuntime(<PullRequestPane worktree={worktree} onOpenChanges={() => undefined} />, (command) =>
      command.type === "review.pr.status"
        ? {
            result: status({
              number: 139,
              url: "https://github.com/acme/app/pull/139",
              state: "OPEN",
              isDraft: false,
              title: "Welcome new installs",
              body: "## What this does\n\nOpens setup on a fresh install.",
              author: { login: "kim" },
              baseRefName: "main",
              headRefName: "feature",
              changedFiles: 25,
              additions: 2570,
              deletions: 20,
              checks: [
                { name: "verify", state: "passed" },
                { name: "android", state: "failed" },
              ],
            }),
          }
        : { result: { threads: [], reviews: [] } },
    );
    await vi.waitFor(() => expect(document.querySelector(".pr-pane-title")?.textContent).toBe("Welcome new installs"));
    const head = document.querySelector(".pr-pane-head")?.textContent ?? "";
    expect(head).toContain("#139");
    expect(head).toContain("kim");
    expect(head).toContain("feature");
    expect(document.querySelector(".pr-pane-tab-count")?.textContent).toBe("25");
    expect(document.querySelector(".pr-pane-checks-head")?.textContent).toContain("1 check failed");
    expect(document.querySelector(".pr-pane-description")?.textContent).toContain("Opens setup on a fresh install.");
    expect([...document.querySelectorAll(".pr-pane-check")].map((item) => item.className)).toEqual([
      "pr-pane-check is-passed",
      "pr-pane-check is-failed",
    ]);
    await act(async () => buttonByText("Merge")?.click());
    expect(document.querySelector('[role="dialog"][aria-label="Merge pull request"]')).not.toBeNull();
  });

  it("says when the branch has no pull request and offers Changes", async () => {
    const opened = vi.fn();
    await renderWithRuntime(<PullRequestPane worktree={worktree} onOpenChanges={opened} />, () => ({
      result: status(),
    }));
    await vi.waitFor(() => expect(document.body.textContent).toContain("feature has no pull request yet."));
    await act(async () => buttonByText("Open Changes")?.click());
    expect(opened).toHaveBeenCalled();
  });

  it("opens the branch's files and a diff in the Code tab, without leaving the pull request", async () => {
    const opened = vi.fn();
    const reviews = [
      {
        worktreeId: worktree.worktreeId,
        baseRef: "origin/main",
        branch: "feature",
        state: "changes",
        files: [
          {
            path: "src/export/invoice.ts",
            kind: "modified",
            staged: false,
            unstaged: false,
            additions: 12,
            deletions: 3,
            binary: false,
          },
        ],
        conflictFiles: [],
        diff: {
          path: "src/export/invoice.ts",
          binary: false,
          patch: "@@ -1,1 +1,1 @@\n-old\n+new\n",
          truncated: false,
          generatedAt: "2026-11-18T10:00:00Z",
        },
        updatedAt: "2026-11-18T10:00:00Z",
      },
    ] as unknown as RuntimeProjection["reviews"];
    const commands = await renderWithRuntime(
      <PullRequestPane worktree={worktree} onOpenChanges={opened} />,
      (command) =>
        command.type === "review.pr.status"
          ? {
              result: status({
                number: 12,
                url: "https://github.com/acme/app/pull/12",
                state: "OPEN",
                isDraft: false,
                title: "Split invoice export",
                baseRefName: "main",
                changedFiles: 1,
              }),
            }
          : { result: { threads: [], reviews: [] } },
      { reviews },
    );
    await vi.waitFor(() => expect(document.querySelector(".pr-pane-title")).not.toBeNull());
    const code = document.querySelector<HTMLButtonElement>('[role="tab"][data-tab="code"]');
    await act(async () => code?.click());
    expect(opened).not.toHaveBeenCalled();
    expect(code?.getAttribute("aria-selected")).toBe("true");
    await vi.waitFor(() =>
      expect(commands).toContainEqual({
        type: "review.refresh",
        worktreeId: worktree.worktreeId,
        baseRef: "origin/main",
      }),
    );
    await vi.waitFor(() =>
      expect(document.querySelector(".pr-code-files .review-file-base")?.textContent).toBe("invoice.ts"),
    );
    expect(document.querySelector(".pr-code-summary")?.textContent).toContain("origin/main");
    await act(async () => document.querySelector<HTMLButtonElement>(".pr-code-files .review-file")?.click());
    expect(commands).toContainEqual({
      type: "review.diff",
      worktreeId: worktree.worktreeId,
      path: "src/export/invoice.ts",
    });
    await vi.waitFor(() => expect(document.querySelector(".pr-code-diff")).not.toBeNull());
    await act(async () => buttonByLabel("Back to the changed files")?.click());
    await act(async () => buttonByText("Open in Changes")?.click());
    expect(opened).toHaveBeenCalled();
  });
});
