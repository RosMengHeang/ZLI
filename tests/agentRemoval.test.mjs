import assert from "node:assert/strict";
import test from "node:test";

test("agent removal releases the process, terminal, panes, and saved record in order", async () => {
  const module = await import("../src/lib/agentRemoval.ts").catch(() => ({}));
  const events = [];

  await module.releaseAgentResources?.(
    { agentId: "agent-1", terminalId: "terminal-1", paneIds: ["pane-1", "pane-2"] },
    {
      stopAgent: async (id) => events.push(`stop:${id}`),
      closeTerminal: async (id) => { events.push(`terminal:${id}`); return true; },
      closePane: (id) => events.push(`pane:${id}`),
      beforeRemove: async () => events.push("discard"),
      removeAgent: (id) => events.push(`remove:${id}`),
    },
  );

  assert.deepEqual(events, [
    "stop:agent-1",
    "terminal:terminal-1",
    "pane:pane-1",
    "pane:pane-2",
    "discard",
    "remove:agent-1",
  ]);
});

test("agent removal keeps the record when terminal cleanup fails", async () => {
  const module = await import("../src/lib/agentRemoval.ts").catch(() => ({}));
  const events = [];

  await assert.rejects(
    module.releaseAgentResources?.(
      { agentId: "agent-1", terminalId: "terminal-1", paneIds: ["pane-1"] },
      {
        stopAgent: async () => events.push("stop"),
        closeTerminal: async () => { events.push("terminal"); return false; },
        closePane: () => events.push("pane"),
        removeAgent: () => events.push("remove"),
      },
    ),
    /terminal could not be closed/i,
  );

  assert.deepEqual(events, ["stop", "terminal"]);
});

test("failed worktree cleanup still releases runtime resources but keeps the agent record", async () => {
  const { releaseAgentResources } = await import("../src/lib/agentRemoval.ts");
  const events = [];

  await assert.rejects(
    releaseAgentResources(
      { agentId: "agent-1", terminalId: "terminal-1", paneIds: ["pane-1"] },
      {
        stopAgent: async () => events.push("stop"),
        closeTerminal: async () => { events.push("terminal"); return true; },
        closePane: () => events.push("pane"),
        beforeRemove: async () => { events.push("discard"); throw new Error("git failed"); },
        removeAgent: () => events.push("remove"),
      },
    ),
    /git failed/i,
  );

  assert.deepEqual(events, ["stop", "terminal", "pane", "discard"]);
});
