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

test("grids from five through twelve use exactly two balanced columns", async () => {
  const { arrangeLeaves, collectLeaves } = await import("../src/stores/paneTree.ts");
  const horizontalSplitCount = (node) =>
    node.type === "leaf"
      ? 0
      : Number(node.direction === "horizontal") + horizontalSplitCount(node.first) + horizontalSplitCount(node.second);

  for (let count = 5; count <= 12; count += 1) {
    const ids = Array.from({ length: count }, (_, index) => String(index + 1));
    const grid = arrangeLeaves(ids.map((id) => ({ id, terminalId: id })), "grid");
    const left = collectLeaves(grid.first).map((leaf) => leaf.terminalId);
    const right = collectLeaves(grid.second).map((leaf) => leaf.terminalId);

    assert.equal(grid.direction, "horizontal", `${count} panes need a two-column root`);
    assert.equal(horizontalSplitCount(grid), 1, `${count} panes must not create a third column`);
    assert.ok(Math.abs(left.length - right.length) <= 1, `${count} panes need balanced columns`);
    assert.deepEqual(left, ids.filter((_, index) => index % 2 === 0));
    assert.deepEqual(right, ids.filter((_, index) => index % 2 === 1));
  }
});

test("two-column grids give every terminal in a column equal height", async () => {
  const { arrangeLeaves } = await import("../src/stores/paneTree.ts");
  const leafHeights = (node, height = 1) => {
    if (node.type === "leaf") return [height];
    const firstHeight = height * node.sizes[0] / 100;
    const secondHeight = height * node.sizes[1] / 100;
    return [
      ...leafHeights(node.first, firstHeight),
      ...leafHeights(node.second, secondHeight),
    ];
  };

  for (let count = 5; count <= 12; count += 1) {
    const ids = Array.from({ length: count }, (_, index) => String(index + 1));
    const grid = arrangeLeaves(ids.map((id) => ({ id, terminalId: id })), "grid");
    for (const column of [grid.first, grid.second]) {
      const heights = leafHeights(column);
      const expected = 1 / heights.length;
      heights.forEach((height) => assert.ok(Math.abs(height - expected) < 0.0001));
    }
  }
});

test("keeps four terminal canvases readable through nested resizing", async () => {
  const { minimumWorkspaceSize, workspacePanelMinSize } = await import("../src/lib/workspaceLayout.ts");
  const leaf = (id) => ({ type: "leaf", id, terminalId: id });
  const column = (id) => ({ type: "split", id, direction: "vertical", sizes: [50, 50], first: leaf(`${id}1`), second: leaf(`${id}2`) });
  const grid = { type: "split", id: "grid", direction: "horizontal", sizes: [50, 50], first: column("left"), second: column("right") };
  assert.deepEqual(minimumWorkspaceSize(leaf("single")), { width: 360, height: 220 });
  assert.deepEqual(minimumWorkspaceSize(grid), { width: 728, height: 448 });
  assert.equal(workspacePanelMinSize(360), "360px");
  assert.equal(workspacePanelMinSize(360, true), "0%");
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
