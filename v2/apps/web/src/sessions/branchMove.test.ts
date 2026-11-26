import type { RuntimeProjection } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { branchTarget, chatBranchName, folderBusy } from "./branchMove.js";

const projectId = "00000000-0000-4000-8000-000000000a01";
const project = { projectId, path: "C:/code/web" } as Parameters<typeof branchTarget>[1];

const worktree = (worktreeId: string, branch: string, path: string, status = "ready") =>
  ({ worktreeId, projectId, branch, path, status }) as RuntimeProjection["worktrees"][number];

const projection = {
  worktrees: [
    worktree("local", "main", "C:/code/web"),
    worktree("feature", "feature", "C:/code/web-worktrees/feature"),
  ],
  threads: [] as RuntimeProjection["threads"],
  terminals: [] as RuntimeProjection["terminals"],
};

describe("branchTarget", () => {
  it("goes to the folder that already has the branch", () => {
    expect(branchTarget(projection, project, { kind: "branch", projectId, branch: "main" })).toMatchObject({
      kind: "use",
      worktree: { worktreeId: "local" },
    });
    expect(
      branchTarget(projection, project, {
        kind: "branch",
        projectId,
        branch: "renamed",
        path: "C:\\code\\web-worktrees\\feature",
      }),
    ).toMatchObject({ kind: "use", worktree: { worktreeId: "feature" } });
  });

  it("checks a free branch out in a new worktree", () => {
    expect(branchTarget(projection, project, { kind: "branch", projectId, branch: "release" })).toEqual({
      kind: "checkout",
      branch: "release",
    });
  });

  it("uses the project's own folder when Git has the branch there and ZLI does not have it yet", () => {
    expect(
      branchTarget({ worktrees: [] }, project, { kind: "branch", projectId, branch: "main", path: "C:/code/web/" }),
    ).toEqual({ kind: "project" });
  });

  it("refuses a branch in a folder ZLI does not manage, and moving a started chat to another project", () => {
    expect(
      branchTarget({ worktrees: [] }, project, { kind: "branch", projectId, branch: "x", path: "D:/elsewhere" }),
    ).toMatchObject({ kind: "error" });
    expect(branchTarget(projection, project, { kind: "project", projectId })).toMatchObject({ kind: "error" });
  });
});

describe("folderBusy", () => {
  it("counts live chats and running agent CLIs, not ended ones", () => {
    const busy = (threads: unknown[], terminals: unknown[] = []) =>
      folderBusy(
        {
          threads: threads as RuntimeProjection["threads"],
          terminals: terminals as RuntimeProjection["terminals"],
        },
        "local",
      );
    expect(busy([{ worktreeId: "local", status: "working" }])).toBe(true);
    expect(busy([{ worktreeId: "local", status: "stopped" }])).toBe(false);
    expect(busy([], [{ worktreeId: "local", kind: "agent", status: "running" }])).toBe(true);
    expect(busy([], [{ worktreeId: "local", kind: "shell", status: "running" }])).toBe(false);
  });
});

describe("chatBranchName", () => {
  it("names a new branch after the busy one and skips names in use", () => {
    expect(chatBranchName("main", projection)).toBe("main-chat");
    expect(chatBranchName("main", { worktrees: [worktree("x", "main-chat", "C:/x")] })).toBe("main-chat-2");
  });
});
