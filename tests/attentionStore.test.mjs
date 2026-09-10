import assert from "node:assert/strict";
import test from "node:test";

const event = ({
  sequence,
  eventId,
  projectId = "project-1",
  agentId = "agent-1",
  kind,
  payload = { type: "empty" },
}) => ({
  schemaVersion: 1,
  sequence,
  eventId,
  projectId,
  agentId,
  parentAgentId: null,
  timestamp: `2026-09-10T00:00:${String(sequence).padStart(2, "0")}Z`,
  source: "runtime",
  kind,
  payload,
});

const quietClient = {
  subscribe: async () => () => {},
  replay: async () => [],
  acknowledgeAgent: async (projectId, agentId) => event({
    sequence: 100,
    eventId: `ack-${projectId}-${agentId}`,
    projectId,
    agentId,
    kind: "attention_ack",
  }),
  markAllRead: async (projectId) => event({
    sequence: 101,
    eventId: `mark-all-${projectId}`,
    projectId,
    agentId: null,
    kind: "attention_mark_all_read",
  }),
};

test("store projects event state and acknowledges only the selected agent", async () => {
  const { createAttentionStoreForTest } = await import("../src/stores/attentionStore.ts");
  const store = createAttentionStoreForTest({ client: quietClient });
  store.getState().apply(event({ sequence: 1, eventId: "wait-a", agentId: "agent-a", kind: "agent_waiting" }));
  store.getState().apply(event({ sequence: 2, eventId: "fail-b", agentId: "agent-b", kind: "agent_failed" }));

  await store.getState().acknowledgeAgent("agent-a", "project-1");

  assert.equal(store.getState().get("agent-a", "project-1")?.unread, false);
  assert.equal(store.getState().get("agent-b", "project-1")?.unread, true);
  assert.equal(store.getState().nextUnreadAgent("project-1"), "agent-b");
});

test("invalid and duplicate envelopes cannot mutate the read model", async () => {
  const { createAttentionStoreForTest } = await import("../src/stores/attentionStore.ts");
  const store = createAttentionStoreForTest({ client: quietClient });
  const waiting = event({ sequence: 1, eventId: "same", kind: "agent_waiting" });

  assert.equal(store.getState().apply({ ...waiting, schemaVersion: 2 }), false);
  assert.equal(store.getState().apply(waiting), true);
  assert.equal(store.getState().apply({ ...waiting, kind: "agent_failed" }), false);
  assert.equal(store.getState().notifications.length, 1);
  assert.equal(store.getState().get("agent-1", "project-1")?.attentionStatus, "waiting_for_you");
});

test("live subscription starts before replay and canonical sequence order wins", async () => {
  const { createAttentionStoreForTest } = await import("../src/stores/attentionStore.ts");
  const calls = [];
  let liveHandler;
  let disposed = false;
  const store = createAttentionStoreForTest({
    client: {
      ...quietClient,
      subscribe: async (handler) => {
        calls.push("subscribe");
        liveHandler = handler;
        return () => { disposed = true; };
      },
      replay: async (cursor) => {
        calls.push(`replay:${cursor}`);
        liveHandler(event({ sequence: 2, eventId: "completed", kind: "agent_completed" }));
        return [event({ sequence: 1, eventId: "started", kind: "agent_started" })];
      },
    },
  });

  const disconnect = await store.getState().connect();

  assert.deepEqual(calls, ["subscribe", "replay:0"]);
  assert.equal(store.getState().get("agent-1", "project-1")?.attentionStatus, "completed");
  assert.equal(store.getState().notifications.length, 1);
  assert.equal(store.getState().loading, false);
  disconnect();
  assert.equal(disposed, true);
});

test("replay keeps the pre-subscription cursor when live delivery starts immediately", async () => {
  const { createAttentionStoreForTest } = await import("../src/stores/attentionStore.ts");
  const replayCursors = [];
  const store = createAttentionStoreForTest({
    client: {
      ...quietClient,
      subscribe: async (handler) => {
        handler(event({ sequence: 2, eventId: "live-completed", kind: "agent_completed" }));
        return () => {};
      },
      replay: async (cursor) => {
        replayCursors.push(cursor);
        return [event({ sequence: 1, eventId: "replayed-start", kind: "agent_started" })];
      },
    },
  });

  const disconnect = await store.getState().connect();

  assert.deepEqual(replayCursors, [0]);
  assert.equal(store.getState().get("agent-1", "project-1")?.attentionStatus, "completed");
  disconnect();
});

test("concurrent bootstrap consumers share one subscription until the final release", async () => {
  const { createAttentionStoreForTest } = await import("../src/stores/attentionStore.ts");
  let subscriptions = 0;
  let disposals = 0;
  const store = createAttentionStoreForTest({
    client: {
      ...quietClient,
      subscribe: async () => {
        subscriptions += 1;
        return () => { disposals += 1; };
      },
    },
  });

  const [releaseFirst, releaseSecond] = await Promise.all([
    store.getState().connect(),
    store.getState().connect(),
  ]);
  assert.equal(subscriptions, 1);
  releaseFirst();
  assert.equal(disposals, 0);
  releaseSecond();
  assert.equal(disposals, 1);
});

test("connection retry reuses the consumer and creates only one listener", async () => {
  const { createAttentionStoreForTest } = await import("../src/stores/attentionStore.ts");
  let attempts = 0;
  let activeListeners = 0;
  const store = createAttentionStoreForTest({
    client: {
      ...quietClient,
      subscribe: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("listener unavailable");
        activeListeners += 1;
        return () => { activeListeners -= 1; };
      },
    },
  });
  store.getState().apply(event({ sequence: 1, eventId: "waiting", kind: "agent_waiting" }));
  const release = await store.getState().connect();

  assert.equal(store.getState().connected, false);
  assert.match(store.getState().error?.message ?? "", /listener unavailable/);
  assert.equal(typeof store.getState().retryConnection, "function");

  await Promise.all([
    store.getState().retryConnection(),
    store.getState().retryConnection(),
  ]);

  assert.equal(attempts, 2);
  assert.equal(activeListeners, 1);
  assert.equal(store.getState().connected, true);
  assert.equal(store.getState().error, null);
  assert.equal(store.getState().get("agent-1", "project-1")?.unread, true);
  release();
  assert.equal(activeListeners, 0);
});

test("acknowledgement failure stays visible and does not clear unread", async () => {
  const { createAttentionStoreForTest } = await import("../src/stores/attentionStore.ts");
  let rejectAck;
  const pendingAck = new Promise((_, reject) => { rejectAck = reject; });
  const store = createAttentionStoreForTest({
    client: { ...quietClient, acknowledgeAgent: async () => pendingAck },
  });
  store.getState().apply(event({ sequence: 1, eventId: "waiting", kind: "agent_waiting" }));

  const acknowledgement = store.getState().acknowledgeAgent("agent-1", "project-1");
  assert.equal(store.getState().get("agent-1", "project-1")?.unread, true);
  rejectAck(new Error("backend unavailable"));
  await acknowledgement;

  assert.equal(store.getState().get("agent-1", "project-1")?.unread, true);
  assert.match(store.getState().error?.message ?? "", /backend unavailable/);
});

test("acknowledgement rejects a valid envelope for the wrong command scope", async () => {
  const { createAttentionStoreForTest } = await import("../src/stores/attentionStore.ts");
  const store = createAttentionStoreForTest({
    client: {
      ...quietClient,
      acknowledgeAgent: async () => event({
        sequence: 2,
        eventId: "wrong-scope",
        projectId: "project-2",
        agentId: "agent-1",
        kind: "attention_ack",
      }),
    },
  });
  store.getState().apply(event({ sequence: 1, eventId: "waiting", kind: "agent_waiting" }));

  assert.equal(await store.getState().acknowledgeAgent("agent-1", "project-1"), false);
  assert.equal(store.getState().get("agent-1", "project-1")?.unread, true);
  assert.match(store.getState().error?.message ?? "", /invalid/i);
});

test("acknowledgement does not require a live agent pane", async () => {
  const { createAttentionStoreForTest } = await import("../src/stores/attentionStore.ts");
  const acknowledged = [];
  const store = createAttentionStoreForTest({
    client: {
      ...quietClient,
      acknowledgeAgent: async (projectId, agentId) => {
        acknowledged.push({ projectId, agentId });
        return event({
          sequence: 2,
          eventId: "stale-agent-ack",
          projectId,
          agentId,
          kind: "attention_ack",
        });
      },
    },
  });
  store.getState().apply(event({ sequence: 1, eventId: "stale-agent-wait", kind: "agent_waiting" }));

  assert.equal(await store.getState().acknowledgeAgent("agent-1", "project-1"), true);
  assert.deepEqual(acknowledged, [{ projectId: "project-1", agentId: "agent-1" }]);
  assert.equal(store.getState().get("agent-1", "project-1")?.unread, false);
});

test("mark all read is scoped to one project and preserves attention state", async () => {
  const { createAttentionStoreForTest } = await import("../src/stores/attentionStore.ts");
  const store = createAttentionStoreForTest({ client: quietClient });
  store.getState().apply(event({ sequence: 1, eventId: "a", projectId: "project-a", kind: "agent_waiting" }));
  store.getState().apply(event({ sequence: 2, eventId: "b", projectId: "project-b", kind: "agent_failed" }));

  await store.getState().markAllRead("project-a");

  assert.deepEqual(
    {
      unread: store.getState().get("agent-1", "project-a")?.unread,
      attention: store.getState().get("agent-1", "project-a")?.attentionStatus,
    },
    { unread: false, attention: "waiting_for_you" },
  );
  assert.equal(store.getState().get("agent-1", "project-b")?.unread, true);
  assert.equal(store.getState().projectUnreadCount("project-a"), 0);
  assert.equal(store.getState().projectUnreadCount("project-b"), 1);
});

test("acknowledged notification history does not reappear on a later unread transition", async () => {
  const { createAttentionStoreForTest } = await import("../src/stores/attentionStore.ts");
  const store = createAttentionStoreForTest({ client: quietClient });
  store.getState().apply(event({ sequence: 1, eventId: "first-wait", kind: "agent_waiting" }));
  await store.getState().acknowledgeAgent("agent-1", "project-1");
  store.getState().apply(event({ sequence: 102, eventId: "restart", kind: "agent_started" }));
  store.getState().apply(event({ sequence: 103, eventId: "later-failure", kind: "agent_failed" }));

  assert.deepEqual(store.getState().notifications.map((item) => item.eventId), ["later-failure"]);
  assert.equal(store.getState().get("agent-1", "project-1")?.unreadCount, 1);
});

test("notification is derived once from pre-event state", async () => {
  const { createAttentionStoreForTest } = await import("../src/stores/attentionStore.ts");
  const store = createAttentionStoreForTest({ client: quietClient });
  store.getState().apply(event({ sequence: 1, eventId: "start", kind: "agent_started" }));
  store.getState().apply(event({ sequence: 2, eventId: "wait-1", kind: "agent_waiting" }));
  store.getState().apply(event({ sequence: 3, eventId: "wait-2", kind: "agent_waiting" }));

  assert.deepEqual(store.getState().notifications.map((item) => item.eventId), ["wait-1"]);
  assert.equal(store.getState().get("agent-1", "project-1")?.unreadCount, 1);
});

test("ordinary progress output stays working after the quiet period", async () => {
  const { createAttentionStoreForTest } = await import("../src/stores/attentionStore.ts");
  let now = 1000;
  const store = createAttentionStoreForTest({
    client: quietClient,
    now: () => now,
  });
  store.getState().apply(event({ sequence: 1, eventId: "start", kind: "agent_started" }));
  store.getState().apply(event({ sequence: 2, eventId: "output-1", kind: "agent_output", payload: { type: "text", text: ">" } }));
  now = 2000;
  store.getState().apply(event({ sequence: 3, eventId: "output-2", kind: "agent_output", payload: { type: "text", text: ">" } }));

  assert.equal(store.getState().get("agent-1", "project-1")?.lastOutputAt, 2000);
  now = 7000;

  assert.equal(store.getState().get("agent-1", "project-1")?.attentionStatus, "working");
  assert.equal(store.getState().get("agent-1", "project-1")?.unread, false);
  assert.equal(store.getState().notifications.length, 0);
});

test("accepted prompt detection promotes waiting once", async () => {
  const { createAttentionStoreForTest } = await import("../src/stores/attentionStore.ts");
  const store = createAttentionStoreForTest({ client: quietClient });
  store.getState().apply(event({ sequence: 1, eventId: "start", kind: "agent_started" }));
  store.getState().apply(event({
    sequence: 2,
    eventId: "accepted-prompt",
    kind: "agent_prompt_detected",
    payload: { type: "attention", reason: "provider_prompt" },
  }));
  store.getState().apply(event({
    sequence: 3,
    eventId: "same-prompt-state",
    kind: "agent_prompt_detected",
    payload: { type: "attention", reason: "provider_prompt" },
  }));

  assert.equal(store.getState().get("agent-1", "project-1")?.attentionStatus, "waiting_for_you");
  assert.equal(store.getState().get("agent-1", "project-1")?.unreadCount, 1);
  assert.deepEqual(store.getState().notifications.map((item) => item.eventId), ["accepted-prompt"]);
});

test("older replay output cannot replace newer live detector state", async () => {
  const { createAttentionStoreForTest } = await import("../src/stores/attentionStore.ts");
  let now = 5000;
  let liveHandler;
  const store = createAttentionStoreForTest({
    client: {
      ...quietClient,
      subscribe: async (handler) => {
        liveHandler = handler;
        return () => {};
      },
      replay: async () => {
        liveHandler(event({ sequence: 5, eventId: "live-output", kind: "agent_output" }));
        now = 9000;
        return [
          event({ sequence: 1, eventId: "replayed-start", kind: "agent_started" }),
          event({ sequence: 2, eventId: "replayed-output", kind: "agent_output" }),
        ];
      },
    },
    now: () => now,
  });

  const disconnect = await store.getState().connect();

  assert.equal(store.getState().get("agent-1", "project-1")?.lastOutputAt, 5000);
  assert.equal(store.getState().get("agent-1", "project-1")?.attentionStatus, "working");
  assert.equal(store.getState().notifications.length, 0);

  store.getState().apply(event({
    sequence: 6,
    eventId: "live-prompt",
    kind: "agent_prompt_detected",
    payload: { type: "attention", reason: "provider_prompt" },
  }));
  assert.equal(store.getState().get("agent-1", "project-1")?.attentionStatus, "waiting_for_you");
  assert.deepEqual(store.getState().notifications.map((item) => item.eventId), ["live-prompt"]);
  disconnect();
});
