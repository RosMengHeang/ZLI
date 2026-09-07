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

test("keeps two columns for a multi-terminal workspace grid", async () => {
  const { gridColumnsFor } = await import("../src/lib/workspaceLayout.ts");

  assert.equal(gridColumnsFor(0), 1);
  assert.equal(gridColumnsFor(1), 1);
  assert.equal(gridColumnsFor(2), 2);
  assert.equal(gridColumnsFor(4), 2);
  assert.equal(gridColumnsFor(6), 2);
});
