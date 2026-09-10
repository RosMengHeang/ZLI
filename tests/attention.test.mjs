import test from "node:test";
import assert from "node:assert/strict";
import { reduceAttention, deriveNotification, shouldPromoteToWaiting } from "../src/lib/attention.ts";

const initial = () => ({ executionStatus: "starting", attentionStatus: "working", unread: false, unreadCount: 0 });
const event = (kind, payload = { type: "empty" }, source = "runtime") => ({
  schemaVersion: 1, sequence: 1, eventId: "evt-1", projectId: "project-1", agentId: "agent-1",
  parentAgentId: null, timestamp: "2026-09-10T00:00:00Z", kind, source, payload,
});

test("attention lifecycle separates execution, attention, and acknowledgement", () => {
  let state = initial();
  const steps = [
    ["agent_started", "running", "working", 0],
    ["agent_waiting", "running", "waiting_for_you", 1],
    ["attention_ack", "running", "waiting_for_you", 0],
    ["agent_prompt_detected", "running", "waiting_for_you", 0],
    ["agent_output", "running", "waiting_for_you", 0],
    ["agent_started", "running", "working", 0],
    ["agent_prompt_detected", "running", "waiting_for_you", 1],
    ["agent_completed", "running", "completed", 2],
    ["agent_exited", "exited", "completed", 2],
    ["attention_mark_all_read", "exited", "completed", 0],
    ["agent_started", "running", "working", 0],
    ["agent_failed", "error", "failed", 1],
    ["agent_exited", "error", "failed", 1],
    ["agent_started", "running", "working", 1],
    ["agent_paused", "paused", "paused", 1],
    ["agent_started", "running", "working", 1],
    ["agent_stopped", "stopped", "offline", 1],
    ["agent_exited", "stopped", "offline", 1],
  ];
  for (const [kind, executionStatus, attentionStatus, unreadCount] of steps) {
    const before = structuredClone(state);
    const next = reduceAttention(state, event(kind));
    assert.deepEqual(state, before, "must not mutate input");
    assert.deepEqual(next, { executionStatus, attentionStatus, unread: unreadCount > 0, unreadCount }, kind);
    state = next;
  }
});

test("attention exit codes distinguish success, failure, and unknown outcome", () => {
  for (const [code, attentionStatus, unreadCount] of [[0, "completed", 1], [7, "failed", 1], [null, "offline", 0]]) {
    assert.deepEqual(reduceAttention(initial(), event("agent_exited", { type: "exit", code })),
      { executionStatus: "exited", attentionStatus, unread: unreadCount > 0, unreadCount });
  }
  assert.deepEqual(reduceAttention(initial(), event("agent_output", { type: "text", text: "Done! >" })), initial());
  assert.deepEqual(reduceAttention(initial(), event("browser_console_error")), initial());
});

test("terminal execution states reject stale lifecycle evidence until an agent starts", () => {
  const terminalStates = [
    { executionStatus: "error", attentionStatus: "failed", unread: true, unreadCount: 4 },
    { executionStatus: "exited", attentionStatus: "completed", unread: false, unreadCount: 0 },
    { executionStatus: "stopped", attentionStatus: "offline", unread: true, unreadCount: 2 },
  ];
  const staleKinds = [
    "agent_prompt_detected",
    "agent_waiting",
    "agent_completed",
    "agent_failed",
    "agent_paused",
    "agent_stopped",
    "agent_exited",
  ];

  for (const state of terminalStates) {
    for (const kind of staleKinds) {
      assert.deepEqual(reduceAttention(state, event(kind)), state, `${state.executionStatus} + ${kind}`);
    }
    assert.deepEqual(reduceAttention(state, event("agent_started")), {
      executionStatus: "running",
      attentionStatus: "working",
      unread: state.unread,
      unreadCount: state.unreadCount,
    }, `${state.executionStatus} + agent_started`);
  }
});

test("attention notification derives once from the pre-event state with safe context", () => {
  const waiting = event("agent_waiting", { type: "attention", reason: "\u001b[31m<script>secret\n" }, "provider");
  const notification = deriveNotification(waiting, initial());
  assert.equal(notification.eventId, "evt-1");
  assert.equal(notification.projectId, "project-1");
  assert.equal(notification.agentId, "agent-1");
  assert.equal(notification.attentionStatus, "waiting_for_you");
  assert.ok(notification.message.length > 0);
  assert.doesNotMatch(notification.message, /secret|<script>|\u001b|\n/);
  const state = reduceAttention(initial(), waiting);
  assert.equal(deriveNotification(waiting, state), null);
  assert.equal(deriveNotification(waiting, reduceAttention(state, event("attention_ack"))), null);
  for (const kind of ["agent_output", "attention_ack", "agent_paused", "agent_stopped", "agent_message_delivered"]) {
    assert.equal(deriveNotification(event(kind), initial()), null, kind);
  }
  for (const kind of ["agent_completed", "agent_failed"]) {
    assert.ok(deriveNotification(event(kind), initial()));
  }
});

test("attention quiet period and hysteresis require evidence and prevent repeated waiting", () => {
  const evidence = { kind: "generic_output", lastOutputAt: 1000 };
  assert.equal(shouldPromoteToWaiting(initial(), evidence, 5999), false);
  assert.equal(shouldPromoteToWaiting(initial(), evidence, 6000), true);
  assert.equal(shouldPromoteToWaiting(initial(), { ...evidence, lastOutputAt: 2000 }, 6000), false);
  assert.equal(shouldPromoteToWaiting(initial(), evidence, 999), false);
  assert.equal(shouldPromoteToWaiting(initial(), { kind: "generic_output" }, 6000), false);
  for (const [lastOutputAt, now] of [
    [-1, 6000],
    [-6000, -1],
    [Number.NaN, 6000],
    [1000, Number.NaN],
    [Number.POSITIVE_INFINITY, 6000],
    [1000, Number.POSITIVE_INFINITY],
    [Number.NEGATIVE_INFINITY, 6000],
    [1000, Number.NEGATIVE_INFINITY],
  ]) {
    assert.equal(shouldPromoteToWaiting(initial(), { kind: "generic_output", lastOutputAt }, now), false,
      `lastOutputAt=${lastOutputAt}, now=${now}`);
  }
  for (const kind of ["provider_hook", "process_exit", "taxchat_delivery", "api", "provider_prompt"]) {
    assert.equal(shouldPromoteToWaiting(initial(), { kind }, 0), true, kind);
  }
  const waiting = reduceAttention(initial(), event("agent_waiting"));
  for (const state of [waiting, reduceAttention(waiting, event("attention_ack")), reduceAttention(initial(), event("agent_completed")), reduceAttention(initial(), event("agent_stopped"))]) {
    assert.equal(shouldPromoteToWaiting(state, evidence, 10000), false);
  }
});

test("high-confidence waiting evidence rejects invalid monotonic time", () => {
  for (const now of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(shouldPromoteToWaiting(initial(), { kind: "provider_hook" }, now), false, `now=${now}`);
  }
});

test("Wave 1 store acceptance preserves lifecycle, acknowledgement, and project scope", async () => {
  const { createAttentionStoreForTest } = await import("../src/stores/attentionStore.ts");
  let sequence = 0;
  let now = 1000;
  const acceptedEvent = ({
    eventId, projectId = "project-1", agentId = "agent-1", kind,
    source = "runtime", payload = { type: "empty" },
  }) => ({
    schemaVersion: 1,
    sequence: ++sequence,
    eventId,
    projectId,
    agentId,
    parentAgentId: null,
    timestamp: `2026-09-10T01:00:${String(sequence).padStart(2, "0")}Z`,
    source,
    kind,
    payload,
  });
  const client = {
    subscribe: async () => () => {},
    replay: async () => [],
    acknowledgeAgent: async (projectId, agentId) => acceptedEvent({
      eventId: `ack-${projectId}-${agentId}`, projectId, agentId, kind: "attention_ack", source: "user",
    }),
    markAllRead: async (projectId) => acceptedEvent({
      eventId: `mark-all-${projectId}`, projectId, agentId: null,
      kind: "attention_mark_all_read", source: "user",
    }),
  };
  const store = createAttentionStoreForTest({ client, now: () => now });
  const apply = (options) => store.getState().apply(acceptedEvent(options));
  const record = (agentId, projectId = "project-1") => store.getState().get(agentId, projectId);

  apply({ eventId: "agent-1-start", kind: "agent_started" });
  apply({
    eventId: "agent-1-output", kind: "agent_output", source: "pty",
    payload: { type: "text", text: "Approve changes? [y/N] >" },
  });
  now = 7000;
  assert.deepEqual(
    [record("agent-1")?.executionStatus, record("agent-1")?.attentionStatus, record("agent-1")?.unreadCount],
    ["running", "working", 0],
  );
  assert.equal(shouldPromoteToWaiting(initial(), { kind: "generic_output", lastOutputAt: 1000 }, 5999), false);
  assert.equal(shouldPromoteToWaiting(initial(), { kind: "generic_output", lastOutputAt: 1000 }, 6000), true);

  apply({
    eventId: "agent-1-provider-prompt", kind: "agent_prompt_detected", source: "provider",
    payload: { type: "attention", reason: "provider_prompt" },
  });
  assert.equal(record("agent-1")?.attentionStatus, "waiting_for_you");
  apply({ eventId: "agent-1-completed", kind: "agent_completed" });
  apply({ eventId: "agent-1-exited", kind: "agent_exited", payload: { type: "exit", code: 0 } });
  apply({ eventId: "agent-1-stale-wait", kind: "agent_waiting", source: "provider" });
  assert.deepEqual(
    [record("agent-1")?.executionStatus, record("agent-1")?.attentionStatus, record("agent-1")?.unreadCount],
    ["exited", "completed", 2],
  );
  assert.equal(await store.getState().acknowledgeAgent("agent-1", "project-1"), true);
  assert.deepEqual(
    [record("agent-1")?.attentionStatus, record("agent-1")?.unread, record("agent-1")?.unreadCount],
    ["completed", false, 0],
  );

  apply({ eventId: "agent-1-restart", kind: "agent_started" });
  apply({ eventId: "agent-1-failed", kind: "agent_failed" });
  apply({ eventId: "agent-1-stale-completed", kind: "agent_completed" });
  apply({ eventId: "agent-2-start", agentId: "agent-2", kind: "agent_started" });
  apply({ eventId: "agent-2-wait", agentId: "agent-2", kind: "agent_waiting", source: "provider" });
  apply({
    eventId: "other-project-failure", projectId: "project-2", agentId: "agent-3", kind: "agent_failed",
  });
  assert.equal(record("agent-1")?.attentionStatus, "failed");
  assert.equal(store.getState().projectUnreadCount("project-1"), 2);
  assert.equal(store.getState().projectUnreadCount("project-2"), 1);

  assert.equal(await store.getState().markAllRead("project-1"), true);
  assert.equal(store.getState().projectUnreadCount("project-1"), 0);
  assert.equal(store.getState().projectUnreadCount("project-2"), 1);
  assert.equal(record("agent-2")?.attentionStatus, "waiting_for_you");
});

test("Wave 1 replay acceptance canonicalizes reordered events and rejects duplicate IDs", async () => {
  const { createAttentionStoreForTest } = await import("../src/stores/attentionStore.ts");
  const replayEvent = ({ sequence, eventId, agentId, kind, source = "runtime", payload = { type: "empty" } }) => ({
    schemaVersion: 1,
    sequence,
    eventId,
    projectId: "project-replay",
    agentId,
    parentAgentId: null,
    timestamp: `2026-09-10T02:00:${String(sequence).padStart(2, "0")}Z`,
    source,
    kind,
    payload,
  });
  const started = replayEvent({ sequence: 1, eventId: "start-a", agentId: "agent-a", kind: "agent_started" });
  const output = replayEvent({
    sequence: 2, eventId: "output-a", agentId: "agent-a", kind: "agent_output", source: "pty",
    payload: { type: "text", text: "Waiting-looking output >" },
  });
  const prompt = replayEvent({
    sequence: 3, eventId: "prompt-a", agentId: "agent-a", kind: "agent_prompt_detected", source: "provider",
    payload: { type: "attention", reason: "provider_prompt" },
  });
  const completed = replayEvent({ sequence: 4, eventId: "completed-a", agentId: "agent-a", kind: "agent_completed" });
  const waiting = replayEvent({
    sequence: 5, eventId: "waiting-b", agentId: "agent-b", kind: "agent_waiting", source: "provider",
  });
  const failed = replayEvent({ sequence: 6, eventId: "failed-b", agentId: "agent-b", kind: "agent_failed" });
  const store = createAttentionStoreForTest({
    now: () => 1000,
    client: {
      subscribe: async (handler) => {
        handler(failed);
        return () => {};
      },
      replay: async () => [waiting, completed, prompt, output, started, { ...prompt, sequence: 7, kind: "agent_failed" }],
      acknowledgeAgent: async () => { throw new Error("not used"); },
      markAllRead: async () => { throw new Error("not used"); },
    },
  });

  const disconnect = await store.getState().connect();

  assert.deepEqual(
    [store.getState().get("agent-a", "project-replay")?.attentionStatus,
      store.getState().get("agent-a", "project-replay")?.unreadCount],
    ["completed", 2],
  );
  assert.deepEqual(
    [store.getState().get("agent-b", "project-replay")?.executionStatus,
      store.getState().get("agent-b", "project-replay")?.attentionStatus,
      store.getState().get("agent-b", "project-replay")?.unreadCount],
    ["error", "failed", 2],
  );
  assert.equal(store.getState().events.length, 6);
  assert.equal(store.getState().lastSequence, 6);
  assert.equal(store.getState().projectUnreadCount("project-replay"), 4);
  assert.deepEqual(
    store.getState().notifications.map(({ eventId }) => eventId),
    ["prompt-a", "completed-a", "waiting-b", "failed-b"],
  );
  disconnect();
});
