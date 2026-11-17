// @vitest-environment jsdom

import type { RuntimeProjection } from "@zli-v2/contracts";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PullRequestsPage } from "./PullRequestsPage.js";
import { resetPullRequestStoreForTests } from "./pullRequestStore.js";
import { cleanupRuntimeRenders, renderWithRuntime, worktree } from "./testRuntime.js";

afterEach(async () => {
  await cleanupRuntimeRenders();
  resetPullRequestStoreForTests();
});

const merged = { ...worktree, worktreeId: "00000000-0000-4000-8000-000000000102", branch: "fix/ocr" };
const draft = { ...worktree, worktreeId: "00000000-0000-4000-8000-000000000103", branch: "feat/export" };
const projection = {
  projects: [{ projectId: worktree.projectId, name: "taxzy", path: "C:/app" }],
  worktrees: [worktree, merged, draft],
  threads: [],
  terminals: [],
} as unknown as RuntimeProjection;

const status = (pullRequest?: Record<string, unknown>) => ({
  branch: "feature",
  uncommittedFiles: 0,
  defaults: { title: "", body: "", base: "main" },
  ...(pullRequest ? { pullRequest } : {}),
});

const pullRequests: Record<string, Record<string, unknown>> = {
  [worktree.worktreeId]: {
    number: 12,
    url: "https://github.com/acme/app/pull/12",
    state: "OPEN",
    isDraft: false,
    title: "Split invoice export by tax year",
    updatedAt: "2026-11-18T10:00:00Z",
    checks: [{ name: "verify", state: "failed" }],
  },
  [draft.worktreeId]: {
    number: 14,
    url: "https://github.com/acme/app/pull/14",
    state: "OPEN",
    isDraft: true,
    title: "Export to PDF",
    updatedAt: "2026-11-18T11:00:00Z",
  },
  [merged.worktreeId]: {
    number: 9,
    url: "https://github.com/acme/app/pull/9",
    state: "MERGED",
    isDraft: false,
    title: "Receipt OCR totals",
    updatedAt: "2026-11-17T09:00:00Z",
  },
};

describe("PullRequestsPage", () => {
  it("lists open pull requests first, newest on top, and opens the chosen one on the right", async () => {
    const onSelect = vi.fn();
    await renderWithRuntime(
      <PullRequestsPage
        projection={projection}
        selectedId={undefined}
        onSelect={onSelect}
        onOpenChanges={() => undefined}
        onShowAgent={() => undefined}
      />,
      (command) =>
        command.type === "review.pr.status"
          ? { result: status(pullRequests[command.worktreeId as string]) }
          : { result: { threads: [], reviews: [] } },
    );
    await vi.waitFor(() => expect(document.querySelectorAll(".pr-list-row")).toHaveLength(3));
    const sections = [...document.querySelectorAll(".pr-list-section")].map((section) => [
      section.getAttribute("aria-label"),
      [...section.querySelectorAll(".pr-list-name")].map((name) => name.textContent),
    ]);
    expect(sections).toEqual([
      ["Open", ["Export to PDF", "Split invoice export by tax year"]],
      ["Merged and closed", ["Receipt OCR totals"]],
    ]);
    expect([...document.querySelectorAll(".pr-list-state")].map((state) => state.textContent)).toEqual([
      "Draft",
      "Checks failed",
      "Merged",
    ]);
    expect(document.querySelector(".pr-list-count")?.textContent).toBe("2 open");
    // With nothing picked, the newest open one is the one on the right.
    expect(document.querySelector(".pr-list-row.is-active .pr-list-name")?.textContent).toBe("Export to PDF");
    const rows = document.querySelectorAll<HTMLButtonElement>(".pr-list-row");
    await act(async () => rows[2]?.click());
    expect(onSelect).toHaveBeenCalledWith(merged.worktreeId);
  });

  it("says where pull requests come from when there are none", async () => {
    await renderWithRuntime(
      <PullRequestsPage
        projection={projection}
        selectedId={undefined}
        onSelect={() => undefined}
        onOpenChanges={() => undefined}
        onShowAgent={() => undefined}
      />,
      (command) => (command.type === "review.pr.status" ? { result: status() } : { result: {} }),
    );
    expect(document.querySelector(".pr-list-empty")?.textContent).toContain("No pull requests yet");
    expect(document.querySelector(".pr-page-empty")).not.toBeNull();
  });
});
