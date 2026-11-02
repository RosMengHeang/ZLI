import { describe, expect, it } from "vitest";

import { resolveBrowserControlWorktree } from "../../browser/BrowserControlActions.js";
import type { MobileDevActionContext } from "../MobileControlActions.js";
import { createProposalFeature } from "./proposalActions.js";
import { createTestDevHost } from "./testHost.js";

const worktrees = [
  { worktreeId: "wt-1", path: "/repo/app", status: "ready" },
  { worktreeId: "wt-2", path: "/repo/other", status: "ready" },
];

/** The dispatch context mobile_propose gets, resolving worktrees the way the real one does. */
const context = {
  worktreeFor: (input: { worktreeId?: string; defaultWorktreeId?: string; cwd?: string }) =>
    resolveBrowserControlWorktree(input, worktrees),
} as unknown as MobileDevActionContext;

function setup() {
  const host = createTestDevHost({ worktrees });
  const action = createProposalFeature(host).actions.mobilepropose;
  if (!action) throw new Error("mobilepropose is not registered");
  return { host, propose: (input: Record<string, unknown>) => action(input, context) };
}

describe("mobile_propose", () => {
  it("labels the card with the agent's own worktree, naming the target when it is another one", async () => {
    const { host, propose } = setup();
    await propose({ title: "Install expo-camera", program: "npx", cwd: "/repo/app", defaultWorktreeId: "wt-1" });
    await propose({ title: "Fix the other app", program: "npm", worktreeId: "wt-2", defaultWorktreeId: "wt-1" });
    const [own, other] = host.proposals.list();
    expect(own).toMatchObject({ worktreeId: "wt-1", sourceLabel: "Proposed by the agent in app" });
    expect(other).toMatchObject({
      worktreeId: "wt-2",
      sourceLabel: "Proposed by the agent in app, for other",
    });
  });

  it("caps a caller's waiting proposals across worktrees, not per target", async () => {
    const { host, propose } = setup();
    for (let index = 0; index < 3; index += 1)
      await propose({ title: `ours ${index}`, program: "npm", defaultWorktreeId: "wt-1" });
    for (let index = 0; index < 2; index += 1)
      await propose({ title: `theirs ${index}`, program: "npm", worktreeId: "wt-2", defaultWorktreeId: "wt-1" });
    await expect(
      propose({ title: "one too many", program: "npm", worktreeId: "wt-2", defaultWorktreeId: "wt-1" }),
    ).rejects.toMatchObject({ status: 429 });
    expect(host.proposals.list("wt-1")).toHaveLength(3);
    expect(host.proposals.list("wt-2")).toHaveLength(2);
  });

  it("labels the card by its target when the caller's own worktree is unknown", async () => {
    const { host, propose } = setup();
    await propose({ title: "Install expo-camera", program: "npx", worktreeId: "wt-2" });
    expect(host.proposals.list()[0]).toMatchObject({
      worktreeId: "wt-2",
      sourceLabel: "Proposed by the agent in other",
    });
  });
});
