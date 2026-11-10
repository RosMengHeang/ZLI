// @vitest-environment jsdom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PullRequestPane } from "./PullRequestPane.js";
import { resetPullRequestStoreForTests } from "./pullRequestStore.js";
import { buttonByText, cleanupRuntimeRenders, renderWithRuntime, worktree } from "./testRuntime.js";

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
  it("shows the pull request like its page: title, branches, size, description, checks, and Merge", async () => {
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
    expect(head).toContain("25 files");
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
});
