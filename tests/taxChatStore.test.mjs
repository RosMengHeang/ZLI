import assert from "node:assert/strict";
import test from "node:test";

const agents = [
  { id: "agent-1", name: "Codex 1", provider: "codex", terminalId: "terminal-1" },
  { id: "agent-2", name: "Claude 1", provider: "claude-code", terminalId: "terminal-2" },
];

function mockTransport(sends = []) {
  return {
    send: async (input) => {
      sends.push(input);
      return {
        messageId: `server-${sends.length}`,
        recipientIds: input.recipientIds,
        queuedIds: input.recipientIds,
        deliveredIds: [],
        failedIds: [],
        scheduled: true,
      };
    },
  };
}

test("starts with selected agents and preserves transcript through pause and continue", async () => {
  const { useTaxChatStore, configureTaxChatRuntime } = await import("../src/stores/taxChatStore.ts");
  configureTaxChatRuntime({
    projectId: "D:/repo",
    transport: mockTransport(),
    bridge: { subscribePtyOutput: () => () => {}, subscribePtyLifecycle: () => () => {} },
  });
  useTaxChatStore.getState().reset();
  useTaxChatStore.getState().setSelectedAgentIds(["agent-1", "agent-2"]);
  useTaxChatStore.getState().start(agents);

  assert.equal(useTaxChatStore.getState().room?.status, "running");
  await useTaxChatStore.getState().send("Compare the plans.", ["agent-1"]);
  const before = useTaxChatStore.getState().room?.messages.length;
  useTaxChatStore.getState().pause("user");
  useTaxChatStore.getState().continueRoom();

  assert.equal(useTaxChatStore.getState().room?.status, "running");
  assert.ok(useTaxChatStore.getState().room?.messages.length >= before);
  assert.equal(useTaxChatStore.getState().room?.participantIds.length, 2);
});

test("routes bridge output through taxchat.send and never uses a PTY write path", async () => {
  let outputListener;
  let lifecycleListener;
  const sends = [];
  const { useTaxChatStore, configureTaxChatRuntime } = await import("../src/stores/taxChatStore.ts");
  configureTaxChatRuntime({
    projectId: "D:/repo",
    transport: mockTransport(sends),
    bridge: {
      subscribePtyOutput: (listener) => {
        outputListener = listener;
        return () => {};
      },
      subscribePtyLifecycle: (listener) => {
        lifecycleListener = listener;
        return () => {};
      },
    },
  });
  useTaxChatStore.getState().reset();
  useTaxChatStore.getState().start(agents);
  outputListener("terminal-1", "[[TAXCHAT:to=agent-2]]\nReview this.\n[[/TAXCHAT]]");
  await Promise.resolve();
  await Promise.resolve();
  lifecycleListener({ type: "exit", terminalId: "terminal-2" });
  await Promise.resolve();

  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].recipientIds, ["agent-2"]);
  assert.equal(sends[0].senderAgentId, "agent-1");
  assert.equal(useTaxChatStore.getState().room?.participants.find((item) => item.agentId === "agent-2").status, "unavailable");
  useTaxChatStore.getState().reset();
  assert.equal(useTaxChatStore.getState().room, null);
});

test("send stays submitted until delivery events arrive", async () => {
  const sends = [];
  const { useTaxChatStore, configureTaxChatRuntime } = await import("../src/stores/taxChatStore.ts");
  configureTaxChatRuntime({
    projectId: "D:/repo",
    transport: mockTransport(sends),
    bridge: { subscribePtyOutput: () => () => {}, subscribePtyLifecycle: () => () => {} },
  });
  useTaxChatStore.getState().reset();
  useTaxChatStore.getState().start(agents);
  await useTaxChatStore.getState().send("Hold for pull.", ["agent-1"]);

  assert.equal(sends.length, 1);
  assert.equal(useTaxChatStore.getState().room?.messages[0].status, "submitted");
  assert.equal(useTaxChatStore.getState().room?.messages[0].id, "server-1");
});

test("projects API TaxChat messages into the visible transcript once", async () => {
  const { useTaxChatStore } = await import("../src/stores/taxChatStore.ts");
  useTaxChatStore.getState().reset();
  const event = {
    schemaVersion: 1,
    sequence: 1,
    eventId: "event-1",
    projectId: "D:/repo",
    agentId: null,
    parentAgentId: null,
    timestamp: "2026-09-11T00:00:00Z",
    source: "taxchat",
    kind: "taxchat_message_queued",
    payload: {
      type: "taxchat",
      messageId: "message-1",
      body: "Review the release",
      recipientIds: ["agent-1"],
      queuedIds: ["agent-1"],
      deliveredIds: [],
      failedIds: [],
    },
  };

  useTaxChatStore.getState().applyEvent(event);
  useTaxChatStore.getState().applyEvent(event);

  assert.equal(useTaxChatStore.getState().room?.messages.length, 1);
  assert.equal(useTaxChatStore.getState().room?.messages[0].body, "Review the release");
  assert.equal(useTaxChatStore.getState().room?.messages[0].status, "submitted");
  assert.deepEqual(useTaxChatStore.getState().room?.participantIds, ["agent-1"]);
});

test("updates one TaxChat transcript message from queued to delivered", async () => {
  const { useTaxChatStore } = await import("../src/stores/taxChatStore.ts");
  useTaxChatStore.getState().reset();
  const base = {
    schemaVersion: 1,
    sequence: 1,
    projectId: "D:/repo",
    agentId: null,
    parentAgentId: null,
    timestamp: "2026-09-11T00:00:00Z",
    source: "taxchat",
    payload: {
      type: "taxchat",
      messageId: "message-queued",
      body: "Wait for the prompt",
      recipientIds: ["agent-1"],
      queuedIds: ["agent-1"],
      deliveredIds: [],
      failedIds: [],
    },
  };

  useTaxChatStore.getState().applyEvent({ ...base, eventId: "queued", kind: "taxchat_message_queued" });
  useTaxChatStore.getState().applyEvent({
    ...base,
    eventId: "delivered",
    sequence: 2,
    kind: "taxchat_message_delivered",
    payload: { ...base.payload, queuedIds: [], deliveredIds: ["agent-1"] },
  });

  assert.equal(useTaxChatStore.getState().room?.messages.length, 1);
  assert.equal(useTaxChatStore.getState().room?.messages[0].status, "delivered");
});

test("restore hydrates transcript after mock reconnect", async () => {
  const { useTaxChatStore, configureTaxChatRuntime } = await import("../src/stores/taxChatStore.ts");
  configureTaxChatRuntime({
    projectId: "D:/repo",
    transport: mockTransport(),
    bridge: { subscribePtyOutput: () => () => {}, subscribePtyLifecycle: () => () => {} },
  });
  useTaxChatStore.getState().reset();
  useTaxChatStore.getState().restore({
    id: "room-1",
    status: "idle",
    participantIds: ["agent-1", "agent-2"],
    participants: [
      { agentId: "agent-1", status: "available", routedCount: 1 },
      { agentId: "agent-2", status: "available", routedCount: 0 },
    ],
    messages: [{
      id: "msg-1",
      senderId: "user",
      recipientIds: ["agent-1"],
      kind: "user",
      body: "Saved transcript",
      createdAt: "2026-09-12T00:00:00Z",
      status: "pending",
      round: 2,
    }],
    round: 2,
  }, agents);

  assert.equal(useTaxChatStore.getState().room?.id, "room-1");
  assert.equal(useTaxChatStore.getState().room?.status, "idle");
  assert.equal(useTaxChatStore.getState().room?.messages[0].body, "Saved transcript");
  assert.equal(useTaxChatStore.getState().room?.messages[0].status, "pending");
});

test("ignores non-TaxChat control events", async () => {
  const { useTaxChatStore } = await import("../src/stores/taxChatStore.ts");
  useTaxChatStore.getState().reset();
  useTaxChatStore.getState().applyEvent({
    schemaVersion: 1,
    sequence: 1,
    eventId: "event-2",
    projectId: "D:/repo",
    agentId: "agent-1",
    parentAgentId: null,
    timestamp: "2026-09-11T00:00:00Z",
    source: "api",
    kind: "agent_message_delivered",
    payload: { type: "message", messageId: "message-2" },
  });

  assert.equal(useTaxChatStore.getState().room, null);
});
