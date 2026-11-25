// @vitest-environment jsdom

import type { RuntimeProjection } from "@zli-v2/contracts";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { groupPullRequests, type PullRequestRow, PullRequestsPage } from "./PullRequestsPage.js";
import { resetPullRequestStoreForTests } from "./pullRequestStore.js";
import { buttonByLabel, cleanupRuntimeRenders, renderWithRuntime, worktree } from "./testRuntime.js";

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
    const names = () => [...document.querySelectorAll(".pr-list-name")].map((name) => name.textContent);
    expect(
      [...document.querySelectorAll(".pr-list-section")].map((section) => section.getAttribute("aria-label")),
    ).toEqual(["Open", "Merged and closed"]);
    expect(names()).toEqual(["Export to PDF", "Split invoice export by tax year", "Receipt OCR totals"]);
    // With nothing picked, the newest open one is the one on the right.
    expect(document.querySelector(".pr-list-row.is-active .pr-list-name")?.textContent).toBe("Export to PDF");

    // The direction button reverses the order inside each section.
    await act(async () => buttonByLabel("Newest first. Reverse the order")?.click());
    expect(names()).toEqual(["Split invoice export by tax year", "Export to PDF", "Receipt OCR totals"]);
    expect(buttonByLabel("Oldest first. Reverse the order")).toBeDefined();

    await act(async () => document.querySelectorAll<HTMLButtonElement>(".pr-list-row")[2]?.click());
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
    expect(document.querySelector(".pr-sort")).toBeNull();
    expect(document.querySelector(".pr-page-empty")).not.toBeNull();
  });

  it("sorts by time, status, project, and number, either way", () => {
    const row = (id: string, project: string, pullRequest: Record<string, unknown>) =>
      ({ worktree: { ...worktree, worktreeId: id }, project, pullRequest }) as unknown as PullRequestRow;
    const rows = [
      row("a", "taxzy", pullRequests[worktree.worktreeId] as Record<string, unknown>),
      row("b", "billing", pullRequests[draft.worktreeId] as Record<string, unknown>),
      row("c", "taxzy", pullRequests[merged.worktreeId] as Record<string, unknown>),
    ];
    const shape = (...args: Parameters<typeof groupPullRequests> extends [unknown, ...infer Rest] ? Rest : never) =>
      groupPullRequests(rows, ...args).map((group) => [
        group.label,
        group.rows.map((entry) => entry.pullRequest.number),
      ]);
    expect(shape("updated")).toEqual([
      ["Open", [14, 12]],
      ["Merged and closed", [9]],
    ]);
    expect(shape("updated", "asc")).toEqual([
      ["Open", [12, 14]],
      ["Merged and closed", [9]],
    ]);
    expect(shape("status")).toEqual([
      ["Checks failed", [12]],
      ["Drafts", [14]],
      ["Merged and closed", [9]],
    ]);
    expect(shape("project")).toEqual([
      ["billing", [14]],
      ["taxzy", [12, 9]],
    ]);
    expect(shape("number", "asc")).toEqual([
      ["Open", [12, 14]],
      ["Merged and closed", [9]],
    ]);
  });
});
