import assert from "node:assert/strict";
import test from "node:test";

const validEvent = {
  schemaVersion: 1,
  sequence: 0,
  eventId: "evt-1",
  projectId: "project-1",
  agentId: "agent-1",
  parentAgentId: null,
  timestamp: "2026-09-10T09:30:00Z",
  source: "runtime",
  kind: "agent_started",
  payload: { type: "empty" },
};

test("agent event decoder accepts a complete normalized envelope", async () => {
  const { isAgentEventEnvelope } = await import("../src/lib/agentEvents.ts");

  assert.equal(isAgentEventEnvelope(validEvent), true);
});

test("agent event decoder accepts a spawned child descriptor", async () => {
  const { isAgentEventEnvelope } = await import("../src/lib/agentEvents.ts");
  const payload = {
    type: "agent",
    name: "Review child",
    providerId: "codex",
    terminalId: "terminal-1",
    branch: "codex/review-child",
    worktreePath: "D:/repo.worktrees/review-child",
    paused: false,
  };

  assert.equal(isAgentEventEnvelope({ ...validEvent, parentAgentId: "parent-1", payload }), true);
  assert.equal(isAgentEventEnvelope({ ...validEvent, payload: { ...payload, terminalId: "" } }), false);
});

test("agent event decoder rejects unsupported and incomplete envelopes", async () => {
  const { isAgentEventEnvelope } = await import("../src/lib/agentEvents.ts");
  const invalidEvents = [
    { ...validEvent, schemaVersion: 2 },
    { ...validEvent, eventId: "" },
    { ...validEvent, projectId: "" },
    { ...validEvent, source: "terminal" },
    { ...validEvent, kind: "agent.started" },
    { ...validEvent, payload: { type: "text", text: 42 } },
    { ...validEvent, payload: { type: "unknown" } },
  ];

  for (const event of invalidEvents) {
    assert.equal(isAgentEventEnvelope(event), false);
  }
});
