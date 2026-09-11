import assert from "node:assert/strict";
import test from "node:test";

function event({ sequence, eventId, agentId, parentAgentId = null, kind = "agent_started", payload = { type: "empty" } }) {
  return {
    schemaVersion: 1,
    sequence,
    eventId,
    projectId: "project-1",
    agentId,
    parentAgentId,
    timestamp: `2026-09-11T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    source: "api",
    kind,
    payload,
  };
}

test("projects parent-child nesting in deterministic event order", async () => {
  const { createTeamStoreForTest } = await import("../src/stores/teamStore.ts");
  const store = createTeamStoreForTest({
    client: { request: async () => { throw new Error("unexpected request"); } },
  });

  store.getState().apply(event({ sequence: 1, eventId: "parent", agentId: "parent-1" }));
  store.getState().apply(event({ sequence: 3, eventId: "child-b", agentId: "child-b", parentAgentId: "parent-1" }));
  store.getState().apply(event({ sequence: 2, eventId: "child-a", agentId: "child-a", parentAgentId: "parent-1" }));

  assert.deepEqual(store.getState().rootAgentIds("project-1"), ["parent-1"]);
  assert.deepEqual(store.getState().childAgentIds("parent-1"), ["child-a", "child-b"]);
  assert.equal(store.getState().agents["child-a"].parentAgentId, "parent-1");
});

test("projects a spawned child descriptor so the UI can open its pane", async () => {
  const { createTeamStoreForTest } = await import("../src/stores/teamStore.ts");
  const store = createTeamStoreForTest({
    client: { request: async () => { throw new Error("unexpected request"); } },
  });

  store.getState().apply(event({
    sequence: 1,
    eventId: "child-started",
    agentId: "child-1",
    parentAgentId: "parent-1",
    payload: {
      type: "agent",
      name: "Review child",
      providerId: "codex",
      terminalId: "terminal-1",
      branch: "codex/review-child",
      worktreePath: "D:/project.worktrees/review-child",
      paused: false,
    },
  }));

  assert.equal(store.getState().agents["child-1"].terminalId, "terminal-1");
  assert.equal(store.getState().agents["child-1"].name, "Review child");
});

test("hydrates durable parent-child relationships after app restart", async () => {
  const { createTeamStoreForTest } = await import("../src/stores/teamStore.ts");
  const store = createTeamStoreForTest({
    client: { request: async () => { throw new Error("unexpected request"); } },
  });

  store.getState().hydrateAgent({
    agentId: "child-1",
    parentAgentId: "parent-1",
    projectId: "project-1",
    providerId: "codex",
    name: "Review child",
    terminalId: "terminal-1",
    branch: "codex/review-child",
    worktreePath: "D:/project.worktrees/review-child",
    status: "stopped",
  });

  assert.deepEqual(store.getState().childAgentIds("parent-1"), ["child-1"]);
  assert.equal(store.getState().agents["child-1"].status, "stopped");
});

test("tracks spawn pending state and installs the successful child", async () => {
  const { createTeamStoreForTest } = await import("../src/stores/teamStore.ts");
  let resolveSpawn;
  const request = new Promise((resolve) => { resolveSpawn = resolve; });
  const store = createTeamStoreForTest({
    createId: () => "spawn-1",
    client: { request: async () => request },
  });

  const spawning = store.getState().spawnAgent({
    projectId: "project-1",
    parentAgentId: "parent-1",
    providerId: "codex",
    task: "Review the API",
  });
  assert.equal(store.getState().spawns["spawn-1"].status, "pending");

  resolveSpawn({
    agentId: "child-1",
    parentAgentId: "parent-1",
    projectId: "project-1",
    providerId: "codex",
    name: "Codex child",
    terminalId: "terminal-1",
    branch: "codex/child-1",
    worktreePath: "D:/project/.worktrees/child-1",
    paused: false,
  });
  const child = await spawning;

  assert.equal(child.agentId, "child-1");
  assert.equal(store.getState().spawns["spawn-1"].status, "succeeded");
  assert.deepEqual(store.getState().childAgentIds("parent-1"), ["child-1"]);
  assert.equal(store.getState().agents["child-1"].terminalId, "terminal-1");
});

test("records spawn failure without adding a child", async () => {
  const { createTeamStoreForTest } = await import("../src/stores/teamStore.ts");
  const store = createTeamStoreForTest({
    createId: () => "spawn-failed",
    client: { request: async () => { throw new Error("Provider unavailable"); } },
  });

  const child = await store.getState().spawnAgent({
    projectId: "project-1",
    parentAgentId: null,
    providerId: "missing",
    task: "Review the API",
  });

  assert.equal(child, null);
  assert.deepEqual(store.getState().spawns["spawn-failed"], {
    id: "spawn-failed",
    projectId: "project-1",
    parentAgentId: null,
    providerId: "missing",
    task: "Review the API",
    status: "failed",
    agentId: null,
    error: "Provider unavailable",
  });
  assert.deepEqual(store.getState().rootAgentIds("project-1"), []);
});

test("enforces twelve active or pending agents before dispatching spawn", async () => {
  const { createTeamStoreForTest } = await import("../src/stores/teamStore.ts");
  let requests = 0;
  const store = createTeamStoreForTest({
    createId: () => "spawn-over-cap",
    client: { request: async () => { requests += 1; return {}; } },
  });
  for (let index = 1; index <= 12; index += 1) {
    store.getState().apply(event({ sequence: index, eventId: `agent-${index}`, agentId: `agent-${index}` }));
  }

  const child = await store.getState().spawnAgent({
    projectId: "project-1",
    parentAgentId: "agent-1",
    providerId: "codex",
    task: "One more",
  });

  assert.equal(child, null);
  assert.equal(requests, 0);
  assert.equal(store.getState().spawns["spawn-over-cap"].error, "This project already has 12 agents");
});

test("waits for delivery confirmation after the server queues a message", async () => {
  const { createTeamStoreForTest } = await import("../src/stores/teamStore.ts");
  let resolveDelivery;
  const firstResponse = new Promise((resolve) => { resolveDelivery = resolve; });
  const responses = [
    firstResponse,
    new Error("Target exited"),
  ];
  let id = 0;
  const store = createTeamStoreForTest({
    createId: () => `delivery-${++id}`,
    client: {
      request: async () => {
        const response = responses.shift();
        if (response instanceof Error) throw response;
        return await response;
      },
    },
  });

  const delivering = store.getState().sendMessage({ projectId: "project-1", agentId: "agent-1", body: "Ready?" });
  assert.equal(store.getState().deliveries["delivery-1"].status, "pending");
  let settled = false;
  void delivering.then(() => { settled = true; });
  resolveDelivery({ messageId: "message-1", queued: true });
  await Promise.resolve();
  assert.equal(settled, false);
  store.getState().apply(event({
    sequence: 1,
    eventId: "message-delivered",
    agentId: "agent-1",
    kind: "agent_message_delivered",
    payload: { type: "message", messageId: "message-1" },
  }));
  const deliveredId = await delivering;
  const failedId = await store.getState().sendMessage({ projectId: "project-1", agentId: "agent-1", body: "Retry?" });

  assert.equal(deliveredId, "delivery-1");
  assert.equal(failedId, "delivery-2");
  assert.equal(store.getState().deliveries[deliveredId].status, "delivered");
  assert.equal(store.getState().deliveries[deliveredId].messageId, "message-1");
  assert.equal(store.getState().deliveries[failedId].status, "failed");
  assert.equal(store.getState().deliveries[failedId].error, "Target exited");
});

test("projects pause and stop only after their commands succeed", async () => {
  const { createTeamStoreForTest } = await import("../src/stores/teamStore.ts");
  const methods = [];
  const store = createTeamStoreForTest({
    client: {
      request: async (method) => {
        methods.push(method);
        return method === "agent.pause"
          ? { agentId: "agent-1", paused: true }
          : { agentId: "agent-1", stopped: true };
      },
    },
  });
  store.getState().apply(event({ sequence: 1, eventId: "start", agentId: "agent-1" }));

  assert.equal(await store.getState().pauseAgent("project-1", "agent-1"), true);
  assert.equal(store.getState().agents["agent-1"].status, "paused");
  assert.equal(await store.getState().stopAgent("project-1", "agent-1"), true);
  assert.equal(store.getState().agents["agent-1"].status, "stopped");
  assert.deepEqual(methods, ["agent.pause", "agent.stop"]);
});

test("projects each event once and prevents stale lifecycle regression", async () => {
  const { createTeamStoreForTest } = await import("../src/stores/teamStore.ts");
  const store = createTeamStoreForTest({
    client: { request: async () => { throw new Error("unexpected request"); } },
  });
  const stopped = event({ sequence: 4, eventId: "stopped", agentId: "agent-1", kind: "agent_stopped" });

  assert.equal(store.getState().apply(stopped), true);
  assert.equal(store.getState().apply(stopped), false);
  assert.equal(store.getState().apply(event({ sequence: 2, eventId: "stale-start", agentId: "agent-1" })), true);

  assert.equal(store.getState().agents["agent-1"].status, "stopped");
  assert.equal(store.getState().agents["agent-1"].lastSequence, 4);
  assert.equal(store.getState().lastSequence, 4);
});

test("projects message delivery events into the delivery read model", async () => {
  const { createTeamStoreForTest } = await import("../src/stores/teamStore.ts");
  const store = createTeamStoreForTest({
    client: { request: async () => { throw new Error("unexpected request"); } },
  });

  store.getState().apply(event({
    sequence: 1,
    eventId: "message-delivered",
    agentId: "agent-1",
    kind: "agent_message_delivered",
    payload: { type: "message", messageId: "message-1" },
  }));

  assert.equal(store.getState().deliveries["message-1"].status, "delivered");
  assert.equal(store.getState().deliveries["message-1"].agentId, "agent-1");
});
