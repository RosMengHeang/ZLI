import type { ProjectProjection } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { createWorktree } from "../sessions/launch.js";
import { guestBranchName, guestDiscardCommand, guestMergeCommand, guestModeOf, guestPermission } from "./guestWork.js";

describe("guest modes", () => {
  it("asks read-only, whatever access the buddy or the chat has", () => {
    expect(guestPermission("ask", "full-access", "full-access")).toBe("read-only");
    expect(guestPermission("ask", undefined, "supervised")).toBe("read-only");
  });

  it("works with the asked-for access, else the chat's, else full access", () => {
    expect(guestPermission("work", "supervised", "full-access")).toBe("supervised");
    expect(guestPermission("work", undefined, "supervised")).toBe("supervised");
    expect(guestPermission("work", undefined, undefined)).toBe("full-access");
  });

  it("names the copy's branch after the chat's branch and the agent, and keeps it unique", () => {
    expect(guestBranchName("main", "Owl", [])).toBe("main-owl");
    expect(guestBranchName("feat/login", "Sky Blue", ["feat/login"])).toBe("feat/login-sky-blue");
    expect(guestBranchName("main", "Owl", ["main-owl", "Main-Owl-2"])).toBe("main-owl-3");
  });

  it("reads a guest's mode from where it runs and its access", () => {
    expect(guestModeOf({ worktreeId: "copy", permissionMode: "full-access" }, "chat")).toBe("work");
    expect(guestModeOf({ worktreeId: "chat", permissionMode: "read-only" }, "chat")).toBe("ask");
    expect(guestModeOf({ worktreeId: "chat", permissionMode: "full-access" }, "chat")).toBeUndefined();
  });

  it("creates the copy as a new worktree branched from the chat's branch", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const project = { projectId: "00000000-0000-4000-8000-000000000010", path: "C:/repo", name: "repo" };
    await createWorktree(
      async (request) => {
        sent.push((request as { command: Record<string, unknown> }).command);
        return undefined;
      },
      project as ProjectProjection,
      guestBranchName("main", "Owl", ["main"]),
      "main",
    );
    expect(sent[0]).toMatchObject({
      type: "worktree.create",
      projectId: project.projectId,
      branch: "main-owl",
      baseRef: "main",
      path: "C:/repo-worktrees/main-owl",
    });
  });

  it("merges the copy into the chat's branch, and discards it with its branch", () => {
    expect(guestMergeCommand({ worktreeId: "copy", targetBranch: "main", name: "Owl" })).toEqual({
      type: "review.merge",
      worktreeId: "copy",
      targetRef: "main",
      commitMessage: "Work from Owl",
    });
    expect(guestDiscardCommand("copy")).toEqual({
      type: "worktree.remove",
      worktreeId: "copy",
      force: true,
      deleteBranch: true,
    });
  });
});
