import assert from "node:assert/strict";
import test from "node:test";

test("grid places four terminals in two columns and two rows", async () => {
  const { arrangeLeaves, collectLeaves } = await import("../src/stores/paneTree.ts");
  const grid = arrangeLeaves(["a", "b", "c", "d"].map((id) => ({ id, terminalId: id })), "grid");
  assert.equal(grid.direction, "horizontal");
  assert.equal(grid.first.direction, "vertical");
  assert.equal(grid.second.direction, "vertical");
  assert.deepEqual(collectLeaves(grid).map((leaf) => leaf.terminalId), ["a", "c", "b", "d"]);
});

test("keeps four terminal canvases readable through nested resizing", async () => {
  const { minimumWorkspaceSize } = await import("../src/lib/workspaceLayout.ts");
  const leaf = (id) => ({ type: "leaf", id, terminalId: id });
  const column = (id) => ({ type: "split", id, direction: "vertical", sizes: [50, 50], first: leaf(`${id}1`), second: leaf(`${id}2`) });
  const grid = { type: "split", id: "grid", direction: "horizontal", sizes: [50, 50], first: column("left"), second: column("right") };
  assert.deepEqual(minimumWorkspaceSize(leaf("single")), { width: 360, height: 220 });
  assert.deepEqual(minimumWorkspaceSize(grid), { width: 728, height: 448 });
  grid.sizes = [30, 70];
  assert.deepEqual(minimumWorkspaceSize(grid), { width: 728, height: 448 });
});

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
