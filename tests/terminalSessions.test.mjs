import assert from "node:assert/strict";
import test from "node:test";

test("registers a launched agent as a running terminal session", async () => {
  const { sessionFromAgent } = await import("../src/lib/terminalSessions.ts");
  const agent = {
    id: "agent-1",
    name: "Codex 1",
    provider: "codex",
    terminalId: "terminal-1",
    cwd: "D:/repo",
    branch: "swarm/codex-1",
    worktreePath: "D:/repo.worktrees/codex-1",
    status: "running",
    error: null,
  };

  assert.deepEqual(sessionFromAgent(agent, 80, 24), {
    id: "terminal-1",
    cwd: "D:/repo",
    status: "running",
    title: "Codex 1",
    provider: "codex",
    cols: 80,
    rows: 24,
    error: null,
  });
});

test("describes a non-uniform 3-pane split instead of an equal grid", async () => {
  const { layoutSignature, collectSplitSizeList, restoreSplitSizes } = await import(
    "../src/lib/workspaceLayout.ts"
  );

  const tree = {
    type: "split",
    id: "root",
    direction: "horizontal",
    sizes: [62, 38],
    first: { type: "leaf", id: "a", terminalId: "t1" },
    second: {
      type: "split",
      id: "stack",
      direction: "vertical",
      sizes: [50, 50],
      first: { type: "leaf", id: "b", terminalId: "t2" },
      second: { type: "leaf", id: "c", terminalId: "t3" },
    },
  };

  assert.equal(layoutSignature(tree), "h(L,v(L,L))");
  assert.deepEqual(collectSplitSizeList(tree), [62, 38, 50, 50]);
  const restored = restoreSplitSizes(tree, "h(L,v(L,L))", [70, 30, 40, 60]);
  assert.deepEqual(collectSplitSizeList(restored), [70, 30, 40, 60]);
});
