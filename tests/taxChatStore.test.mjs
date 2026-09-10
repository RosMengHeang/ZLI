import assert from "node:assert/strict";
import test from "node:test";

const agents = [
  { id: "agent-1", name: "Codex 1", provider: "codex", terminalId: "terminal-1" },
  { id: "agent-2", name: "Claude 1", provider: "claude-code", terminalId: "terminal-2" },
];

test("starts with selected agents and preserves transcript through pause and continue", async () => {
  const { useTaxChatStore, configureTaxChatRuntime } = await import("../src/stores/taxChatStore.ts");
  configureTaxChatRuntime({
    transport: { write: async () => {} },
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

test("routes bridge output through the active room and resets without closing terminals", async () => {
  let outputListener;
  let lifecycleListener;
  const writes = [];
  const { useTaxChatStore, configureTaxChatRuntime } = await import("../src/stores/taxChatStore.ts");
  configureTaxChatRuntime({
    transport: { write: async (terminalId, data) => writes.push({ terminalId, data }) },
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
  lifecycleListener({ type: "exit", terminalId: "terminal-2" });
  await Promise.resolve();

  assert.equal(writes[0].terminalId, "terminal-2");
  assert.equal(useTaxChatStore.getState().room?.participants.find((item) => item.agentId === "agent-2").status, "unavailable");
  useTaxChatStore.getState().reset();
  assert.equal(useTaxChatStore.getState().room, null);
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
    kind: "taxchat_message_sent",
    payload: {
      type: "taxchat",
      messageId: "message-1",
      body: "Review the release",
      recipientIds: ["agent-1"],
      deliveredIds: ["agent-1"],
      failedIds: [],
    },
  };

  useTaxChatStore.getState().applyEvent(event);
  useTaxChatStore.getState().applyEvent(event);

  assert.equal(useTaxChatStore.getState().room?.messages.length, 1);
  assert.equal(useTaxChatStore.getState().room?.messages[0].body, "Review the release");
  assert.deepEqual(useTaxChatStore.getState().room?.participantIds, ["agent-1"]);
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
