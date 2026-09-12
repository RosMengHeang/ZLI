import assert from "node:assert/strict";
import test from "node:test";

const agents = [
  { id: "agent-1", name: "Codex 1", provider: "codex", terminalId: "terminal-1" },
  { id: "agent-2", name: "Claude 1", provider: "claude-code", terminalId: "terminal-2" },
];

function createOptions(overrides = {}) {
  return {
    projectId: "D:/repo",
    agents,
    settings: { inactivityMs: 45000, perAgentMessageLimit: 8, totalMessageLimit: 64 },
    transport: {
      send: async ({ recipientIds }) => ({
        messageId: "message-1",
        recipientIds,
        queuedIds: recipientIds,
        deliveredIds: [],
        failedIds: [],
        scheduled: true,
      }),
    },
    onEvent: () => {},
    ...overrides,
  };
}

test("submits a user message once via taxchat.send and keeps it submitted", async () => {
  const sends = [];
  const events = [];
  const { createTaxChatCoordinator } = await import("../src/lib/taxChatCoordinator.ts");
  const coordinator = createTaxChatCoordinator(
    createOptions({
      transport: {
        send: async (input) => {
          sends.push(input);
          return {
            messageId: "server-1",
            recipientIds: input.recipientIds,
            queuedIds: input.recipientIds,
            deliveredIds: [],
            failedIds: [],
            scheduled: true,
          };
        },
      },
      onEvent: (event) => events.push(event),
    }),
  );

  coordinator.start();
  await coordinator.sendUserMessage("Compare the plans.", ["agent-1", "agent-2"]);

  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].recipientIds, ["agent-1", "agent-2"]);
  assert.equal(sends[0].body, "Compare the plans.");
  assert.equal(sends[0].projectId, "D:/repo");
  const userMessage = coordinator.snapshot().messages.find((message) => message.kind === "user");
  assert.equal(userMessage?.id, "server-1");
  assert.equal(userMessage?.status, "submitted");
});

test("routes an agent block through taxchat.send and accepts a user-directed update", async () => {
  const sends = [];
  const events = [];
  const { createTaxChatCoordinator } = await import("../src/lib/taxChatCoordinator.ts");
  const coordinator = createTaxChatCoordinator(
    createOptions({
      transport: {
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
      },
      onEvent: (event) => events.push(event),
    }),
  );

  coordinator.start();
  coordinator.handleOutput("agent-1", "[[TAXCHAT:to=agent-2]]\nReview auth.\n[[/TAXCHAT]]");
  await Promise.resolve();
  await Promise.resolve();
  coordinator.handleOutput("agent-2", "[[TAXCHAT:to=user]]\nAuth looks good.\n[[/TAXCHAT]]");

  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].recipientIds, ["agent-2"]);
  assert.equal(sends[0].senderAgentId, "agent-1");
  assert.match(events.filter((event) => event.type === "message").at(-1).message.body, /Auth looks good/);
});

test("pauses on limits, keeps terminals untouched, and marks exited agents unavailable", async () => {
  const events = [];
  const { createTaxChatCoordinator } = await import("../src/lib/taxChatCoordinator.ts");
  const coordinator = createTaxChatCoordinator(
    createOptions({
      settings: { inactivityMs: 45000, perAgentMessageLimit: 1, totalMessageLimit: 1 },
      onEvent: (event) => events.push(event),
    }),
  );

  coordinator.start();
  coordinator.handleOutput("agent-1", "[[TAXCHAT:to=agent-2]]\nOne.\n[[/TAXCHAT]]");
  await Promise.resolve();
  await Promise.resolve();
  coordinator.handleOutput("agent-1", "[[TAXCHAT:to=agent-2]]\nTwo.\n[[/TAXCHAT]]");
  coordinator.handleAgentExit("agent-2");

  assert.equal(coordinator.snapshot().status, "paused");
  assert.equal(coordinator.snapshot().participants.find((item) => item.agentId === "agent-2").status, "unavailable");
  assert.ok(events.some((event) => event.type === "status" && event.status === "paused"));
});

test("serializes concurrent sends and does not route malformed output", async () => {
  const sends = [];
  let releaseFirst;
  const firstSend = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const { createTaxChatCoordinator } = await import("../src/lib/taxChatCoordinator.ts");
  const coordinator = createTaxChatCoordinator(
    createOptions({
      transport: {
        send: async (input) => {
          sends.push(input);
          if (sends.length === 1) await firstSend;
          return {
            messageId: `server-${sends.length}`,
            recipientIds: input.recipientIds,
            queuedIds: input.recipientIds,
            deliveredIds: [],
            failedIds: [],
            scheduled: true,
          };
        },
      },
    }),
  );

  coordinator.start();
  const first = coordinator.sendUserMessage("First", ["agent-1"]);
  const second = coordinator.sendUserMessage("Second", ["agent-1"]);
  await Promise.resolve();
  assert.equal(sends.length, 1);
  coordinator.handleOutput("agent-1", "[[TAXCHAT:to=unknown agent]]bad[[/TAXCHAT]]");
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(sends.length, 2);
});

test("hydrate restores transcript and status without claiming delivery", async () => {
  const { createTaxChatCoordinator } = await import("../src/lib/taxChatCoordinator.ts");
  const coordinator = createTaxChatCoordinator(createOptions());
  coordinator.hydrate({
    status: "idle",
    round: 3,
    participants: [
      { agentId: "agent-1", status: "available", routedCount: 1 },
      { agentId: "agent-2", status: "queued", routedCount: 2 },
    ],
    messages: [{
      id: "msg-1",
      senderId: "user",
      recipientIds: ["agent-1"],
      kind: "user",
      body: "Resume this",
      createdAt: "2026-09-12T00:00:00Z",
      status: "pending",
      round: 3,
    }],
  });

  const snapshot = coordinator.snapshot();
  assert.equal(snapshot.status, "idle");
  assert.equal(snapshot.round, 3);
  assert.equal(snapshot.messages[0].body, "Resume this");
  assert.equal(snapshot.messages[0].status, "pending");
});
