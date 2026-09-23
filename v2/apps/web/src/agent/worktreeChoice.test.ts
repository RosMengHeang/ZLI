import { ProjectId, type RuntimeProjection, ThreadId, WorktreeId, type WorktreeProjection } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { defaultWorktreeForNewAgent } from "./worktreeChoice.js";

const projectId = ProjectId.parse("00000000-0000-4000-8000-000000000010");
const currentId = WorktreeId.parse("00000000-0000-4000-8000-000000000011");
const freeId = WorktreeId.parse("00000000-0000-4000-8000-000000000012");
const queuedId = WorktreeId.parse("00000000-0000-4000-8000-000000000013");

const current: WorktreeProjection = {
  worktreeId: currentId,
  projectId,
  path: "/repo/current",
  branch: "current",
  status: "ready",
};

function state(
  threads: RuntimeProjection["threads"],
  worktrees: WorktreeProjection[],
): Pick<RuntimeProjection, "threads" | "worktrees"> {
  return { threads, worktrees };
}

describe("defaultWorktreeForNewAgent", () => {
  it("keeps a free selection, prefers another ready worktree, and otherwise asks to create one", () => {
    expect(defaultWorktreeForNewAgent(state([], [current]), current)).toEqual({ mode: "current" });
    expect(
      defaultWorktreeForNewAgent(
        state(
          [
            {
              threadId: ThreadId.parse("00000000-0000-4000-8000-000000000021"),
              worktreeId: currentId,
              provider: "codex",
              status: "idle",
              capabilities: {},
            },
          ],
          [
            current,
            { worktreeId: queuedId, projectId, path: "/repo/queued", branch: "queued", status: "creating" },
            { worktreeId: freeId, projectId, path: "/repo/free", branch: "free", status: "ready" },
          ],
        ),
        current,
      ).mode,
    ).toBe("free");
    expect(
      defaultWorktreeForNewAgent(
        state(
          [
            {
              threadId: ThreadId.parse("00000000-0000-4000-8000-000000000021"),
              worktreeId: currentId,
              provider: "codex",
              status: "waiting",
              capabilities: {},
            },
          ],
          [current, { worktreeId: queuedId, projectId, path: "/repo/queued", branch: "queued", status: "queued" }],
        ),
        current,
      ),
    ).toEqual({ mode: "create" });
  });
});
