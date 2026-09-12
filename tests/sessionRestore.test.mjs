import assert from "node:assert/strict";
import test from "node:test";

const checkpointWithAgent = (availability, attached = false) => ({
  schemaVersion: 1,
  projectId: "D:/project",
  agents: [{
    descriptor: {
      sessionId: "session-1",
      projectId: "D:/project",
      agentId: "agent-1",
      name: "Cursor",
      providerId: "cursor-agent",
      terminalId: "terminal-1",
      workingDirectory: "D:/project",
      branch: "main",
      worktreePath: null,
      attached,
      resume: availability === "available"
        ? {
          type: "available",
          id: "session-token-1",
          provenance: { marker: "session id", sourceLine: "Session ID: session-token-1", capturedAt: "0" },
          resumeCommandKind: "session_id",
        }
        : availability === "unsupported"
          ? { type: "unsupported" }
          : { type: "unknown", reason: "no session id marker", lastProbeAt: "0" },
    },
    scrollback: "saved output",
  }],
  paneTree: null,
  browser: [],
  taxChatRoom: null,
  lastEventSequence: 4,
  savedAt: "2026-09-10T09:30:00Z",
});

test("restore keeps an unsupported provider visible without pretending it resumed", async () => {
  const { createSessionStoreForTest } = await import("../src/stores/sessionStore.ts");
  const store = createSessionStoreForTest({
    reconnect: async () => ({ protocolVersion: 1, currentSequence: 0, events: [], sessions: [] }),
    restoreProject: async () => ({ snapshot: null, sessionIds: [], createdSessionIds: [] }),
    resume: async () => { throw new Error("should not auto-resume"); },
  });

  await store.restoreSession(checkpointWithAgent("unsupported"));

  assert.equal(store.getState().agents["agent-1"].resumeAvailability, "unsupported");
  assert.equal(store.getState().agents["agent-1"].restoreMessage, "Resume unavailable for this provider");
  assert.equal(store.getState().agents["agent-1"].pending, false);
});

test("restore exposes separate resume, reconnect, and new-session actions", async () => {
  const { createSessionStoreForTest } = await import("../src/stores/sessionStore.ts");
  const store = createSessionStoreForTest({
    reconnect: async () => ({ protocolVersion: 1, currentSequence: 0, events: [], sessions: [] }),
    restoreProject: async () => ({ snapshot: null, sessionIds: [], createdSessionIds: [] }),
    resume: async () => ({ terminalId: "terminal-live", attached: true }),
  });

  await store.restoreSession(checkpointWithAgent("available"));
  assert.equal(store.getState().agents["agent-1"].action, "resume");
  await store.resumeAgent("agent-1");
  assert.equal(store.getState().agents["agent-1"].action, "reconnect");
  assert.equal(store.getState().agents["agent-1"].terminalId, "terminal-live");

  await store.restoreSession(checkpointWithAgent("unknown"));
  assert.equal(store.getState().agents["agent-1"].action, "new_session");
});

test("initialize automatically resumes an agent that was running at the last checkpoint", async () => {
  const { createSessionStoreForTest } = await import("../src/stores/sessionStore.ts");
  let resumeCalls = 0;
  const checkpoint = checkpointWithAgent("available", true);
  const store = createSessionStoreForTest({
    restoreProject: async () => ({ snapshot: checkpoint, sessionIds: ["session-1"], createdSessionIds: [] }),
    reconnect: async () => ({
      protocolVersion: 1,
      currentSequence: 4,
      events: [],
      sessions: [{ ...checkpoint.agents[0].descriptor, attached: false }],
    }),
    resume: async () => {
      resumeCalls += 1;
      return { ...checkpoint.agents[0].descriptor, terminalId: "terminal-resumed", attached: true };
    },
  });

  await store.getState().initialize("D:/project");

  assert.equal(resumeCalls, 1);
  assert.equal(store.getState().phase, "ready");
  assert.equal(store.getState().agents["agent-1"].terminalId, "terminal-resumed");
  assert.equal(store.getState().agents["agent-1"].connected, true);
  assert.equal(store.getState().agents["agent-1"].action, "reconnect");
});

test("initialize leaves an intentionally stopped resumable agent for manual recovery", async () => {
  const { createSessionStoreForTest } = await import("../src/stores/sessionStore.ts");
  let resumeCalls = 0;
  const checkpoint = checkpointWithAgent("available");
  const store = createSessionStoreForTest({
    restoreProject: async () => ({ snapshot: checkpoint, sessionIds: ["session-1"], createdSessionIds: [] }),
    reconnect: async () => ({
      protocolVersion: 1,
      currentSequence: 4,
      events: [],
      sessions: [{ ...checkpoint.agents[0].descriptor, attached: false }],
    }),
    resume: async () => {
      resumeCalls += 1;
      return { ...checkpoint.agents[0].descriptor, terminalId: "unexpected", attached: true };
    },
  });

  await store.getState().initialize("D:/project");

  assert.equal(resumeCalls, 0);
  assert.equal(store.getState().agents["agent-1"].action, "resume");
  assert.equal(store.getState().agents["agent-1"].connected, false);
});

test("restore is idempotent and invalid checkpoints cannot partially replace state", async () => {
  const { createSessionStoreForTest } = await import("../src/stores/sessionStore.ts");
  const store = createSessionStoreForTest({
    reconnect: async () => ({ protocolVersion: 1, currentSequence: 0, events: [], sessions: [] }),
    restoreProject: async () => ({ snapshot: null, sessionIds: [], createdSessionIds: [] }),
    resume: async () => { throw new Error("unused"); },
  });
  const checkpoint = checkpointWithAgent("available");

  await store.restoreSession(checkpoint);
  await store.restoreSession(checkpoint);
  assert.deepEqual(Object.keys(store.getState().agents), ["agent-1"]);

  await store.restoreSession({ ...checkpoint, schemaVersion: 99, agents: [] });
  assert.deepEqual(Object.keys(store.getState().agents), ["agent-1"]);
  assert.equal(store.getState().error, "Session checkpoint is invalid");
});

test("a pending resume suppresses duplicate requests", async () => {
  const { createSessionStoreForTest } = await import("../src/stores/sessionStore.ts");
  let release;
  let calls = 0;
  const resumed = new Promise((resolve) => { release = resolve; });
  const store = createSessionStoreForTest({
    reconnect: async () => ({ protocolVersion: 1, currentSequence: 0, events: [], sessions: [] }),
    restoreProject: async () => ({ snapshot: null, sessionIds: [], createdSessionIds: [] }),
    resume: async () => {
      calls += 1;
      await resumed;
      return { ...checkpointWithAgent("available").agents[0].descriptor, terminalId: "terminal-live", attached: true };
    },
  });

  await store.restoreSession(checkpointWithAgent("available"));
  const first = store.resumeAgent("agent-1");
  const second = store.resumeAgent("agent-1");
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test("restoreSession applies taxChatRoom after agents are restored", async () => {
  const { createSessionStoreForTest } = await import("../src/stores/sessionStore.ts");
  const { useTaxChatStore, configureTaxChatRuntime } = await import("../src/stores/taxChatStore.ts");
  configureTaxChatRuntime({
    projectId: "D:/project",
    transport: {
      send: async ({ recipientIds }) => ({
        messageId: "unused",
        recipientIds,
        queuedIds: recipientIds,
        deliveredIds: [],
        failedIds: [],
        scheduled: false,
      }),
    },
    bridge: null,
  });
  useTaxChatStore.getState().reset();
  const store = createSessionStoreForTest({
    reconnect: async () => ({ protocolVersion: 1, currentSequence: 0, events: [], sessions: [] }),
    restoreProject: async () => ({ snapshot: null, sessionIds: [], createdSessionIds: [] }),
    resume: async () => { throw new Error("unused"); },
  });
  const checkpoint = {
    ...checkpointWithAgent("available"),
    taxChatRoom: {
      id: "room-restored",
      status: "idle",
      participantIds: ["agent-1"],
      participants: [{ agentId: "agent-1", status: "available", routedCount: 0 }],
      messages: [{
        id: "msg-1",
        senderId: "user",
        recipientIds: ["agent-1"],
        kind: "user",
        body: "Checkpointed TaxChat",
        createdAt: "2026-09-12T00:00:00Z",
        status: "pending",
        round: 1,
      }],
      round: 1,
    },
  };

  await store.restoreSession(checkpoint);

  assert.equal(store.getState().agents["agent-1"].id, "agent-1");
  assert.equal(useTaxChatStore.getState().room?.id, "room-restored");
  assert.equal(useTaxChatStore.getState().room?.messages[0].body, "Checkpointed TaxChat");
});

test("forget removes the restored agent from local state after backend cleanup", async () => {
  const { createSessionStoreForTest } = await import("../src/stores/sessionStore.ts");
  const calls = [];
  const store = createSessionStoreForTest({
    reconnect: async () => ({ protocolVersion: 1, currentSequence: 0, events: [], sessions: [] }),
    restoreProject: async () => ({ snapshot: null, sessionIds: [], createdSessionIds: [] }),
    forget: async (projectId, sessionId) => {
      calls.push({ projectId, sessionId });
      return true;
    },
    resume: async () => { throw new Error("unused"); },
  });

  await store.restoreSession(checkpointWithAgent("unsupported"));
  await store.getState().forgetAgent("agent-1");

  assert.deepEqual(calls, [{ projectId: "D:/project", sessionId: "session-1" }]);
  assert.deepEqual(store.getState().agents, {});
});
