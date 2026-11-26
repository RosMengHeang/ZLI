import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS, parseWorktreePrefs, updateAppSettings } from "../settings/appSettings.js";
import { createWorktree, worktreeFolder, worktreeOnBranch } from "./launch.js";

afterEach(() => {
  updateAppSettings(() => structuredClone(DEFAULT_SETTINGS));
});

const project = {
  projectId: "00000000-0000-4000-8000-000000000a01",
  name: "web",
  path: "C:/code/web/",
} as Parameters<typeof createWorktree>[1];

describe("worktree settings", () => {
  it("puts worktrees next to the project, or in the chosen folder under the project's name", () => {
    expect(worktreeFolder(project, {})).toBe("C:/code/web-worktrees");
    expect(worktreeFolder(project, { location: "D:\\worktrees\\" })).toBe("D:\\worktrees/web");
  });

  it("reads only well-formed worktree settings", () => {
    expect(parseWorktreePrefs(undefined)).toEqual({ fromRemote: false, removeWithAgent: false });
    expect(parseWorktreePrefs({ location: "  D:/wt ", fromRemote: true, removeWithAgent: "yes" })).toEqual({
      location: "D:/wt",
      fromRemote: true,
      removeWithAgent: false,
    });
  });

  it("creates new worktrees in the chosen folder and from the remote when asked", async () => {
    updateAppSettings((current) => ({
      ...current,
      worktrees: { location: "D:/wt", fromRemote: true, removeWithAgent: false },
    }));
    const dispatch = vi.fn(async (request: { commandId: string }) => ({
      commandId: request.commandId,
      accepted: true,
    }));
    await createWorktree(dispatch as never, project, "zli/claude-k3f9", "main");
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      command: {
        type: "worktree.create",
        workspaceRoot: "D:/wt/web",
        path: "D:/wt/web/zli-claude-k3f9",
        baseRef: "main",
        fromRemote: true,
      },
    });
    // Checking out a branch that already exists never fetches a base.
    await createWorktree(dispatch as never, project, "feature", "", true);
    expect(dispatch.mock.calls[1]?.[0]).not.toHaveProperty("command.fromRemote");
  });
});

describe("worktreeOnBranch", () => {
  const worktree = (worktreeId: string, branch: string, status: string, projectId: string = project.projectId) =>
    ({ worktreeId, projectId, branch, status, path: `C:/code/${worktreeId}` }) as Parameters<
      typeof worktreeOnBranch
    >[0]["worktrees"][number];

  it("finds the folder that already has a branch, so a chat moves there instead of asking Git for a second one", () => {
    const projection = {
      worktrees: [
        worktree("other-project", "main", "ready", "00000000-0000-4000-8000-000000000a02"),
        worktree("gone", "main", "failed"),
        worktree("checkout", "main", "ready"),
      ],
    };
    expect(worktreeOnBranch(projection, project.projectId, "main")?.worktreeId).toBe("checkout");
    expect(worktreeOnBranch(projection, project.projectId, "release")).toBeUndefined();
  });
});
