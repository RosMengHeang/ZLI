# ZLI Agent Events and Attention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create one normalized agent event stream and a deterministic attention reducer that powers Working, Waiting for you, Completed, Failed, Paused, Offline, and unread UI state.

**Architecture:** Adapt existing PTY lifecycle/output signals into a backend event hub, then expose a typed frontend read model. Keep execution status, attention status, and unread state separate. Provider parsers emit evidence; a reducer owns state transitions; UI components render the resulting read model.

**Tech Stack:** Rust 2021, Tauri 2 events, `serde`, React 19, TypeScript 6, Zustand 5, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-10-agent-control-plane-design.md`

## Global Constraints

- Hard project limit: 12 agents.
- ZLI will not call an LLM to classify terminal output.
- Events are append-only, versioned, sequenced, and deduplicated by `eventId`.
- The frontend is a read-model client and is not the source of truth for live agent state.
- Existing PTY launch, stop, TaxChat, layout, and worktree behavior must remain intact.
- Every new interactive UI control must have real behavior, keyboard access, loading state, and error state.

## File map

- Create `src-tauri/src/control/mod.rs`: control-plane module registration and shared state.
- Create `src-tauri/src/control/events.rs`: Rust event envelopes and event kinds.
- Create `src-tauri/src/control/event_hub.rs`: sequenced in-process event publication and replay buffer.
- Create `src-tauri/src/control/attention.rs`: backend attention transition rules.
- Modify `src-tauri/src/pty/manager.rs`: emit normalized lifecycle evidence without changing PTY ownership.
- Modify `src-tauri/src/commands.rs`: forward normalized events through Tauri.
- Modify `src-tauri/src/lib.rs`: register control state and event commands.
- Create `src/lib/agentEvents.ts`: frontend event contracts and decoders.
- Create `src/lib/attention.ts`: pure frontend reducer and notification derivation.
- Create `src/stores/attentionStore.ts`: Zustand read model and acknowledgement actions.
- Modify `src/stores/agentStore.ts`: consume event projections rather than inventing status locally.
- Modify `src/components/Sidebar.tsx`: render status and unread state.
- Modify `src/components/StatusBadge.tsx`: render semantic attention states.
- Create `src/components/NotificationCenter.tsx`: list, focus, acknowledge, and clear notifications.
- Create `tests/agentEvents.test.mjs`, `tests/attention.test.mjs`, and `src-tauri/src/control/tests.rs`.

## Interfaces

Rust and TypeScript must represent the same wire fields:

```ts
export type ExecutionStatus =
  | "starting" | "running" | "paused" | "exited" | "error" | "stopped";

export type AttentionStatus =
  | "working" | "waiting_for_you" | "completed" | "failed" | "paused" | "offline";

export interface AgentEventEnvelope<T = unknown> {
  schemaVersion: 1;
  sequence: number;
  eventId: string;
  projectId: string;
  agentId: string | null;
  parentAgentId: string | null;
  timestamp: string;
  source: "runtime" | "provider" | "pty" | "taxchat" | "browser" | "user" | "api";
  kind: AgentEventKind;
  payload: T;
}
```

### Task 1: Add normalized event contracts

**Files:**
- Create: `src-tauri/src/control/mod.rs`
- Create: `src-tauri/src/control/events.rs`
- Create: `src/lib/agentEvents.ts`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/control/tests.rs`
- Test: `tests/agentEvents.test.mjs`

**Interfaces:**
- Produces `AgentEventEnvelope`, `AgentEventKind`, `ExecutionStatus`, `AttentionStatus`, and serde/TypeScript-compatible field names.
- Consumes existing `TerminalOutputEvent` and `TerminalStatusEvent` payload shapes from `src-tauri/src/pty/manager.rs`.

- [ ] **Step 1: Write the failing Rust contract test**

```rust
#[test]
fn event_envelope_round_trips_with_schema_version_and_sequence() {
    let event = AgentEventEnvelope::new(
        "evt-1".into(),
        "project-1".into(),
        Some("agent-1".into()),
        AgentEventKind::AgentStarted,
        AgentEventPayload::Empty,
    );
    let json = serde_json::to_string(&event).expect("serialize event");
    let decoded: AgentEventEnvelope = serde_json::from_str(&json).expect("deserialize event");
    assert_eq!(decoded.schema_version, 1);
    assert_eq!(decoded.sequence, 0);
    assert_eq!(decoded.event_id, "evt-1");
}
```

- [ ] **Step 2: Run the failing Rust test**

Run: `cargo test --manifest-path src-tauri/Cargo.toml control::tests::event_envelope_round_trips_with_schema_version_and_sequence`

Expected: FAIL because the control module and event types do not exist.

- [ ] **Step 3: Implement the Rust contracts**

Define serde enums using `#[serde(rename_all = "snake_case")]`. Give `AgentEventEnvelope` a constructor that sets `schema_version` to `1`, `sequence` to `0`, the supplied `event_id`, UTC RFC3339 timestamp, and the supplied event fields. Keep payload variants small and serializable: `Empty`, `Text { text: String }`, `Exit { code: Option<i32> }`, `Attention { reason: String }`, and `Message { message_id: String }`.

- [ ] **Step 4: Add the TypeScript contract decoder**

Implement `isAgentEventEnvelope(value: unknown): value is AgentEventEnvelope` and reject unknown schema versions, missing IDs, invalid source values, and invalid event kinds. Do not cast arbitrary Tauri payloads without validation.

- [ ] **Step 5: Run contract tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml control::tests::event_envelope_round_trips_with_schema_version_and_sequence`

Run: `npm test -- --test-name-pattern="agent event"`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/control src-tauri/src/lib.rs src/lib/agentEvents.ts tests/agentEvents.test.mjs
git commit -m "feat: add normalized agent event contracts"
```

### Task 2: Add the sequenced event hub

**Files:**
- Create: `src-tauri/src/control/event_hub.rs`
- Modify: `src-tauri/src/pty/manager.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/control/tests.rs`

**Interfaces:**
- Consumes: `AgentEventEnvelope` from Task 1.
- Produces `EventHub::publish`, `EventHub::subscribe_after`, and `EventHub::latest_sequence`.

- [ ] **Step 1: Write the failing event hub tests**

```rust
#[test]
fn event_hub_assigns_monotonic_sequence_and_replays_after_cursor() {
    let hub = EventHub::new(32);
    let first = hub.publish(test_event("one"));
    let second = hub.publish(test_event("two"));
    assert_eq!(first.sequence, 1);
    assert_eq!(second.sequence, 2);
    let replay = hub.subscribe_after(1);
    assert_eq!(replay.len(), 1);
    assert_eq!(replay[0].event_id, "two");
}

#[test]
fn event_hub_does_not_duplicate_event_ids() {
    let hub = EventHub::new(32);
    hub.publish(test_event("same"));
    hub.publish(test_event("same"));
    assert_eq!(hub.len(), 1);
}
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml control::tests::event_hub_`

Expected: FAIL because `EventHub` is not defined.

- [ ] **Step 3: Implement bounded replay**

Use `Arc<Mutex<HubState>>` with a monotonically increasing `u64` sequence, a `VecDeque<AgentEventEnvelope>`, a `HashSet<String>` of event IDs, and the configured capacity. `publish` assigns the next sequence and returns the stored envelope. `subscribe_after` returns only events with `sequence > cursor`.

- [ ] **Step 4: Adapt PTY evidence**

At the existing Rust PTY output/status emission boundary, publish `agent.output`, `agent.started`, `agent.exited`, and `agent.failed` evidence when an agent-to-terminal mapping is available. Preserve the existing Tauri terminal events so xterm rendering does not depend on the new reducer.

- [ ] **Step 5: Add Tauri forwarding**

Register a `control-event` Tauri event containing the validated envelope. Add a `control_events_after(sequence)` command for reconnect replay. The command returns an empty array when the cursor is newer than the current sequence.

- [ ] **Step 6: Run Rust checks**

Run: `cargo test --manifest-path src-tauri/Cargo.toml control::tests::event_hub_`

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/control/event_hub.rs src-tauri/src/pty/manager.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/src/control/tests.rs
git commit -m "feat: add sequenced agent event hub"
```

### Task 3: Implement deterministic attention transitions

**Files:**
- Create: `src-tauri/src/control/attention.rs`
- Create: `src/lib/attention.ts`
- Test: `src-tauri/src/control/tests.rs`
- Test: `tests/attention.test.mjs`

**Interfaces:**
- Consumes: normalized event envelopes from Task 2.
- Produces `reduceAttention(state, event)`, `deriveNotification(event, state)`, and backend `AttentionReducer::apply`.

- [ ] **Step 1: Write the failing transition table test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { reduceAttention } from "../src/lib/attention.ts";

test("attention reducer maps lifecycle and explicit waiting events", () => {
  let state = { executionStatus: "starting", attentionStatus: "working", unread: false, unreadCount: 0 };
  state = reduceAttention(state, { kind: "agent.started", source: "runtime" });
  assert.equal(state.attentionStatus, "working");
  state = reduceAttention(state, { kind: "agent.waiting", source: "provider" });
  assert.equal(state.attentionStatus, "waiting_for_you");
  assert.equal(state.unread, true);
  state = reduceAttention(state, { kind: "agent.completed", source: "runtime" });
  assert.equal(state.attentionStatus, "completed");
  assert.equal(state.unreadCount, 2);
});

test("acknowledgement clears unread without changing attention", () => {
  const state = { executionStatus: "exited", attentionStatus: "completed", unread: true, unreadCount: 1 };
  const next = reduceAttention(state, { kind: "attention.ack", source: "user" });
  assert.equal(next.attentionStatus, "completed");
  assert.equal(next.unread, false);
  assert.equal(next.unreadCount, 0);
});
```

- [ ] **Step 2: Run the tests to verify failure**

Run: `npm test -- --test-name-pattern="attention reducer"`

Expected: FAIL because the reducer is not defined.

- [ ] **Step 3: Implement the transition table**

Implement explicit transitions for `agent.started`, `agent.prompt_detected`, `agent.waiting`, `agent.completed`, `agent.failed`, `agent.paused`, `agent.exited`, `agent.stopped`, `attention.ack`, and `attention.mark_all_read`. Keep `unreadCount` monotonic until acknowledgement. Ignore duplicate events by event ID in the store layer.

- [ ] **Step 4: Add hysteresis and debounce helpers**

Implement `shouldPromoteToWaiting(lastState, evidence, now)` with a five-second quiet period for low-confidence generic output. Explicit hooks, process exit, TaxChat delivery and API events bypass the quiet period. Repeated low-confidence output must not create repeated notifications.

- [ ] **Step 5: Run the reducer tests**

Run: `npm test -- --test-name-pattern="attention"`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/control/attention.rs src/lib/attention.ts src-tauri/src/control/tests.rs tests/attention.test.mjs
git commit -m "feat: add deterministic agent attention reducer"
```

### Task 4: Add the frontend read model and notifications

**Files:**
- Create: `src/stores/attentionStore.ts`
- Create: `src/components/NotificationCenter.tsx`
- Modify: `src/stores/agentStore.ts`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/StatusBadge.tsx`
- Modify: `src/components/TopBar.tsx`
- Modify: `src/components/AppShell.tsx` (or a dedicated bootstrap hook)
- Create: `src/tauri/control.ts`
- Modify: `src-tauri/src/commands.rs` and `src-tauri/src/lib.rs` (registered acknowledgement commands)
- Test: `tests/attentionStore.test.mjs`

**Interfaces:**
- Consumes: `control-event` envelopes and `attention.ack` commands.
- Produces `useAttentionStore`, `acknowledgeAgent(agentId)`, `markAllRead()`, and `nextUnreadAgent(projectId)`.

- [ ] **Step 1: Write store behavior tests**

```js
test("store projects event state and acknowledges only the selected agent", () => {
  const store = createAttentionStoreForTest();
  store.apply(eventFor("agent-a", "agent.waiting"));
  store.apply(eventFor("agent-b", "agent.failed"));
  store.acknowledgeAgent("agent-a");
  assert.equal(store.get("agent-a").unread, false);
  assert.equal(store.get("agent-b").unread, true);
  assert.equal(store.nextUnreadAgent(), "agent-b");
});
```

- [ ] **Step 2: Run the test to verify failure**

Run: `npm test -- --test-name-pattern="store projects event state"`

Expected: FAIL because the store does not exist.

- [ ] **Step 3: Implement the store**

Subscribe once in the app bootstrap to the Tauri `control-event`. Validate the envelope with `isAgentEventEnvelope`, ignore already-seen event IDs, reduce each agent record, and expose selectors for project unread count and next unread agent. Dispatch acknowledgement commands through the future control client boundary; for this task use the existing typed Tauri invoke wrapper.

Register backend acknowledgement commands and publish their normalized events through the existing hub. Subscribe before requesting replay, merge live and replay events by sequence/event ID, and dispose listeners on unmount. Acknowledgement errors must remain visible and must not silently mark an agent read. Use the binding snake_case event names throughout.

- [ ] **Step 4: Render semantic statuses**

Update `StatusBadge` to render text and accessible labels for all six attention states. Use one small status dot and text; do not add decorative gradients, glows, or generic badges. `Sidebar` shows a functional unread marker and project attention count. Hover and keyboard focus reveal the same agent action affordances.

- [ ] **Step 5: Add NotificationCenter behavior**

Render newest unread items first. Clicking an item focuses the agent pane and acknowledges only that item. Add “Mark all read” with a real handler. Render loading, empty, and error states. Close the panel with Escape.

- [ ] **Step 6: Run frontend checks**

Run: `npm test -- --test-name-pattern="attention"`

Run: `npm run build`

Run: `npm run lint`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/stores/attentionStore.ts src/components/NotificationCenter.tsx src/stores/agentStore.ts src/components/Sidebar.tsx src/components/StatusBadge.tsx src/components/TopBar.tsx tests/attentionStore.test.mjs
git commit -m "feat: show agent attention and unread notifications"
```

### Task 5: Verify the completed attention subsystem

**Files:**
- Modify: `tests/attention.test.mjs`
- Modify: `src-tauri/src/control/tests.rs`
- Modify: `docs/HANDOFF_CODEX.md`

- [ ] **Step 1: Add the lifecycle acceptance test**

Cover start, explicit waiting, completion, failure, acknowledgement, duplicate event replay, low-confidence debounce, and project unread count.

- [ ] **Step 2: Run the full verification set**

Run: `npm test`

Run: `npm run lint`

Run: `npm run build`

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: all existing and new tests pass.

- [ ] **Step 3: Record the new contract**

Update `docs/HANDOFF_CODEX.md` with the event names, state separation rule, and the command used to run the verification set.

- [ ] **Step 4: Commit**

```bash
git add tests/attention.test.mjs src-tauri/src/control/tests.rs docs/HANDOFF_CODEX.md
git commit -m "test: verify agent attention subsystem"
```
