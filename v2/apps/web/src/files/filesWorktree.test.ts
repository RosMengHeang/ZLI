import type { ProjectProjection, WorktreeProjection } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { filesWorktreeFor } from "./filesWorktree.js";

const PLAIN = "00000000-0000-4000-8000-000000000001";
const REPO = "00000000-0000-4000-8000-000000000002";
const projects = [
  { projectId: PLAIN, path: "/work/plain", name: "plain", git: false },
  { projectId: REPO, path: "/work/repo", name: "repo" },
] as ProjectProjection[];

function worktree(id: string, projectId: string, status: WorktreeProjection["status"], extra = {}): WorktreeProjection {
  return { worktreeId: id, projectId, path: `/work/${id}`, branch: "main", status, ...extra } as WorktreeProjection;
}

describe("filesWorktreeFor", () => {
  it("shows a ready worktree as it is", () => {
    const ready = worktree("a", REPO, "ready");
    expect(filesWorktreeFor({ projects, worktrees: [ready] }, ready, undefined)).toEqual({
      worktree: ready,
      needsCheckout: false,
    });
  });

  it("shows the checkout of a folder without Git instead of a worktree that never gets ready", () => {
    const stuck = worktree("stuck", PLAIN, "queued");
    const checkout = worktree("checkout", PLAIN, "ready", { kind: "checkout", path: "/work/plain" });
    expect(filesWorktreeFor({ projects, worktrees: [stuck, checkout] }, stuck, undefined).worktree).toBe(checkout);
    expect(filesWorktreeFor({ projects, worktrees: [stuck] }, stuck, undefined)).toEqual({
      worktree: stuck,
      needsCheckout: true,
    });
  });

  it("keeps a Git worktree that is still being prepared unless a folder of the same project was picked", () => {
    const creating = worktree("creating", REPO, "creating");
    const checkout = worktree("checkout", REPO, "ready", { kind: "checkout" });
    const other = worktree("other", PLAIN, "ready");
    const projection = { projects, worktrees: [creating, checkout, other] };
    expect(filesWorktreeFor(projection, creating, undefined)).toEqual({ worktree: creating, needsCheckout: false });
    expect(filesWorktreeFor(projection, creating, "checkout").worktree).toBe(checkout);
    expect(filesWorktreeFor(projection, creating, "other").worktree).toBe(creating);
  });
});
