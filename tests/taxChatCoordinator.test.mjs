import assert from "node:assert/strict";
import test from "node:test";

const agents = [
  { id: "agent-1", name: "Codex 1", provider: "codex", terminalId: "terminal-1" },
  { id: "agent-2", name: "Claude 1", provider: "claude-code", terminalId: "terminal-2" },
];

function createOptions(overrides = {}) {
  return {
    agents,
    settings: { inactivityMs: 45000, perAgentMessageLimit: 8, totalMessageLimit: 64 },
    transport: { write: async () => {} },
    onEvent: () => {},
    ...overrides,
  };
}

test("queues a user message once per selected recipient", async () => {
  const writes = [];
  const events = [];
  const { createTaxChatCoordinator } = await import("../src/lib/taxChatCoordinator.ts");
  const coordinator = createTaxChatCoordinator(
    createOptions({
      transport: { write: async (terminalId, data) => writes.push({ terminalId, data }) },
      onEvent: (event) => events.push(event),
    }),
  );

  coordinator.start();
  await coordinator.sendUserMessage("Compare the plans.", ["agent-1", "agent-2"]);

  assert.deepEqual(writes.map((item) => item.terminalId), ["terminal-1", "terminal-2"]);
  assert.equal(events.find((event) => event.type === "message").message.kind, "user");
});

test("routes an agent block to another agent and accepts a user-directed update", async () => {
  const writes = [];
  const events = [];
  const { createTaxChatCoordinator } = await import("../src/lib/taxChatCoordinator.ts");
  const coordinator = createTaxChatCoordinator(
    createOptions({
      transport: { write: async (terminalId, data) => writes.push({ terminalId, data }) },
      onEvent: (event) => events.push(event),
    }),
  );

  coordinator.start();
  coordinator.handleOutput("agent-1", "[[TAXCHAT:to=agent-2]]\nReview auth.\n[[/TAXCHAT]]");
  coordinator.handleOutput("agent-2", "[[TAXCHAT:to=user]]\nAuth looks good.\n[[/TAXCHAT]]");

  assert.equal(writes.length, 1);
  assert.equal(writes[0].terminalId, "terminal-2");
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
  coordinator.handleOutput("agent-1", "[[TAXCHAT:to=agent-2]]\nTwo.\n[[/TAXCHAT]]");
  coordinator.handleAgentExit("agent-2");

  assert.equal(coordinator.snapshot().status, "paused");
  assert.equal(coordinator.snapshot().participants.find((item) => item.agentId === "agent-2").status, "unavailable");
  assert.ok(events.some((event) => event.type === "status" && event.status === "paused"));
});

test("serializes concurrent writes per agent and does not route malformed output", async () => {
  const writes = [];
  let releaseFirst;
  const firstWrite = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const { createTaxChatCoordinator } = await import("../src/lib/taxChatCoordinator.ts");
  const coordinator = createTaxChatCoordinator(
    createOptions({
      transport: {
        write: async (terminalId, data) => {
          writes.push({ terminalId, data });
          if (writes.length === 1) await firstWrite;
        },
      },
    }),
  );

  coordinator.start();
  const first = coordinator.sendUserMessage("First", ["agent-1"]);
  const second = coordinator.sendUserMessage("Second", ["agent-1"]);
  await Promise.resolve();
  assert.equal(writes.length, 1);
  coordinator.handleOutput("agent-1", "[[TAXCHAT:to=unknown agent]]bad[[/TAXCHAT]]");
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(writes.length, 2);
});
