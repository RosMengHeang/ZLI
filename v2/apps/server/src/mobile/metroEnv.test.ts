import { metroPortFor } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { metroEnv, projectionMetroEnv } from "./metroEnv.js";

const worktrees = [
  { worktreeId: "main", kind: "checkout", status: "ready" },
  { worktreeId: "wt-a", kind: "worktree", status: "ready" },
  { worktreeId: "wt-gone", kind: "worktree", status: "cancelled" },
];

describe("metroEnv", () => {
  it("sets both keys to the worktree's port and nothing for the checkout", () => {
    const port = String(metroPortFor("wt-a", worktrees));
    expect(metroEnv("wt-a", worktrees)).toEqual({ ZLI_METRO_PORT: port, RCT_METRO_PORT: port });
    expect(metroEnv("main", worktrees)).toEqual({});
    expect(metroEnv("wt-gone", worktrees)).toEqual({});
    expect(metroEnv("unknown", worktrees)).toEqual({});
    expect(metroEnv(undefined, worktrees)).toEqual({});
  });

  it("reads the projection and adds nothing when it cannot", async () => {
    const port = String(metroPortFor("wt-a", worktrees));
    await expect(projectionMetroEnv({ projection: async () => ({ worktrees }) as never }, "wt-a")).resolves.toEqual({
      ZLI_METRO_PORT: port,
      RCT_METRO_PORT: port,
    });
    await expect(
      projectionMetroEnv(
        {
          projection: async () => {
            throw new Error("closed");
          },
        },
        "wt-a",
      ),
    ).resolves.toEqual({});
  });
});
