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
