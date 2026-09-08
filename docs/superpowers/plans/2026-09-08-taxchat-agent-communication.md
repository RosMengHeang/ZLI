# TaxChat Agent Communication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local TaxChat room where the user and selected CLI agents can exchange structured messages beside the existing terminal grid.

**Architecture:** Keep the current agent launch and PTY ownership unchanged. Add a pure protocol parser, a transport-injected TaxChat coordinator with serialized per-agent queues, a Zustand room store, and a resizable React pane integrated inside `Workspace`. The PTY bridge publishes a copy of output to TaxChat while continuing to render every raw byte in the existing xterm.

**Tech Stack:** React 19, TypeScript 6, Zustand 5, `react-resizable-panels`, Tauri 2 PTY events, Node's built-in test runner with `--experimental-strip-types`, existing CSS token system.

**Spec:** `docs/superpowers/specs/2026-09-08-taxchat-agent-communication-design.md`

## Global Constraints

- TaxChat communication uses only the local app and existing local PTY sessions; no cloud orchestration or provider API is added.
- The initial transport is the existing `Agent.terminalId` and `ptyWrite`; no wrapper process is introduced.
- Smart-round defaults are 45 seconds inactivity, 8 routed messages per agent per round, and 64 routed messages across the room per round.
- Unrecognized or malformed protocol output remains in the terminal and is never routed automatically.
- The existing PTY bridge remains the source of truth for terminal rendering; TaxChat only consumes a copy.
- Pause, Continue, and Stop must not kill or close existing terminal sessions.
- The TaxChat pane is beside the terminal grid; the browser remains the outer right-side shell panel.
- Use existing palette tokens, Bricolage/Segoe UI text, IBM Plex Mono for protocol/status details, visible focus states, and reduced-motion-safe transitions.

---

## File Map

Create the following focused files:

- `src/lib/taxChatProtocol.ts` — ANSI cleanup, incremental protocol parsing, and delivery prompt formatting.
- `src/lib/taxChatCoordinator.ts` — room lifecycle, smart-round timers, recipient routing, and serialized delivery queues.
- `src/stores/taxChatStore.ts` — React-facing room state and coordinator wiring.
- `src/lib/taxChatPresentation.ts` — pure UI labels, tones, and recipient helpers.
- `src/components/TaxChatPanel.tsx` — TaxChat transcript, composer, participant controls, and state actions.
- `tests/taxChatProtocol.test.mjs` — parser and prompt tests.
- `tests/taxChatCoordinator.test.mjs` — queue, lifecycle, routing, safety, and failure tests.
- `tests/taxChatPresentation.test.mjs` — pure presentation helper tests.

Modify these existing files:

- `src/types/models.ts` — shared TaxChat contracts.
- `src/types/commands.ts` — typed PTY lifecycle payloads if needed by the output subscription.
- `src/terminal/ptyBridge.ts` — publish output/lifecycle copies without changing terminal rendering.
- `src/stores/uiStore.ts` — add `taxChatOpen` and its toggle action.
- `src/components/Workspace.tsx` — place TaxChat in a resizable panel beside terminals.
- `src/components/TopBar.tsx` — add a clear TaxChat open/close action.
- `src/index.css` — TaxChat pane, transcript, composer, status, and participant styles using existing tokens.

Do not modify Rust PTY commands or provider launch commands in the first implementation; the approved design keeps the first version provider-agnostic and local to the frontend coordinator.

---

### Task 1: Define the TaxChat contracts and incremental protocol parser

**Files:**
- Modify: `src/types/models.ts`
- Create: `src/lib/taxChatProtocol.ts`
- Create: `tests/taxChatProtocol.test.mjs`

**Interfaces:**
- Produces `TaxChatRoomStatus`, `TaxChatMessageKind`, `TaxChatMessageStatus`, `TaxChatParticipant`, `TaxChatMessage`, `TaxChatRoomSettings`, `TaxChatRoom`, and `TaxChatProtocolBlock` types.
- Produces `stripTaxChatAnsi(input: string): string`.
- Produces `consumeTaxChatChunk(state: TaxChatParserState, senderId: string, chunk: string): { state: TaxChatParserState; blocks: TaxChatProtocolBlock[] }`.
- Produces `formatTaxChatDelivery(input: { senderName: string; senderId: string; recipientIds: string[]; transcript: string }): string`.

- [ ] **Step 1: Write failing parser tests**

```js
import assert from "node:assert/strict";
import test from "node:test";

test("parses a complete TaxChat block and keeps ordinary output outside the block", async () => {
  const { consumeTaxChatChunk } = await import("../src/lib/taxChatProtocol.ts");
  const result = consumeTaxChatChunk(
    { buffer: "" },
    "agent-1",
    "thinking\n[[TAXCHAT:to=agent-2]]\nPlease inspect the migration.\n[[/TAXCHAT]]\nready> ",
  );

  assert.deepEqual(result.blocks, [
    { senderId: "agent-1", recipient: "agent-2", body: "Please inspect the migration." },
  ]);
  assert.equal(result.state.buffer, "");
});

test("completes a marker split across PTY chunks", async () => {
  const { consumeTaxChatChunk } = await import("../src/lib/taxChatProtocol.ts");
  const first = consumeTaxChatChunk({ buffer: "" }, "agent-1", "[[TAXCHAT:to=all]]\ncheck");
  const second = consumeTaxChatChunk(first.state, "agent-1", " the tests\n[[/TAXCHAT]]");

  assert.deepEqual(second.blocks, [
    { senderId: "agent-1", recipient: "all", body: "check the tests" },
  ]);
});

test("rejects malformed recipients and strips ANSI before parsing", async () => {
  const { consumeTaxChatChunk } = await import("../src/lib/taxChatProtocol.ts");
  const result = consumeTaxChatChunk(
    { buffer: "" },
    "agent-1",
    "\u001b[32m[[TAXCHAT:to=unknown agent]]\u001b[0m\nnope\n[[/TAXCHAT]]",
  );

  assert.deepEqual(result.blocks, []);
});

test("formats a tagged delivery with shared TaxChat context", async () => {
  const { formatTaxChatDelivery } = await import("../src/lib/taxChatProtocol.ts");
  assert.match(
    formatTaxChatDelivery({
      senderName: "You",
      senderId: "user",
      recipientIds: ["agent-1"],
      transcript: "You: Compare the two approaches.",
    }),
    /TaxChat|Compare the two approaches/,
  );
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --experimental-strip-types --test tests/taxChatProtocol.test.mjs`

Expected: FAIL because `taxChatProtocol.ts` and the TaxChat contracts do not exist yet.

- [ ] **Step 3: Add the contracts and minimal parser**

Add these model shapes to `src/types/models.ts`:

```ts
export type TaxChatRoomStatus = "ready" | "running" | "idle" | "paused" | "stopped";
export type TaxChatMessageKind = "user" | "agent" | "delivery" | "system" | "error";
export type TaxChatMessageStatus = "pending" | "delivered" | "failed" | "informational";

export interface TaxChatParticipant {
  agentId: AgentId;
  status: "available" | "queued" | "delivering" | "unavailable";
  routedCount: number;
}

export interface TaxChatMessage {
  id: string;
  senderId: string;
  recipientIds: string[];
  kind: TaxChatMessageKind;
  body: string;
  createdAt: string;
  status: TaxChatMessageStatus;
  round: number;
}

export interface TaxChatRoomSettings {
  inactivityMs: number;
  perAgentMessageLimit: number;
  totalMessageLimit: number;
}

export interface TaxChatRoom {
  id: string;
  status: TaxChatRoomStatus;
  participantIds: AgentId[];
  messages: TaxChatMessage[];
  round: number;
}

export interface TaxChatProtocolBlock {
  senderId: AgentId;
  recipient: AgentId | "all" | "user";
  body: string;
}
```

Implement the parser with the exact marker format `[[TAXCHAT:to=<recipient>]]` and `[[/TAXCHAT]]`. Keep a partial marker/body in `state.buffer`, parse multiple complete blocks from one chunk, normalize message bodies with trimmed line endings, and accept only alphanumeric IDs plus `.`, `_`, `:`, and `-`, or the reserved values `all` and `user`. Remove common CSI ANSI sequences before matching.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `node --experimental-strip-types --test tests/taxChatProtocol.test.mjs`

Expected: PASS for all parser and formatting tests.

- [ ] **Step 5: Commit**

```bash
git add src/types/models.ts src/lib/taxChatProtocol.ts tests/taxChatProtocol.test.mjs
git commit -m "feat: add TaxChat protocol contracts"
```

### Task 2: Build the provider-agnostic TaxChat coordinator

**Files:**
- Create: `src/lib/taxChatCoordinator.ts`
- Create: `tests/taxChatCoordinator.test.mjs`

**Interfaces:**
- Consumes the Task 1 parser and models.
- Consumes `TaxChatAgentDescriptor = { id: string; name: string; provider: string; terminalId: string }`.
- Consumes `TaxChatTransport = { write: (terminalId: string, data: string) => Promise<void> }`.
- Produces `createTaxChatCoordinator(options): TaxChatCoordinator`.
- Produces coordinator methods `start()`, `pause(reason?)`, `continue()`, `stop()`, `sendUserMessage(body, recipientIds)`, `handleOutput(agentId, chunk)`, `handleAgentExit(agentId)`, `snapshot()`, and `dispose()`.

- [ ] **Step 1: Write failing coordinator tests**

```js
import assert from "node:assert/strict";
import test from "node:test";

const agents = [
  { id: "agent-1", name: "Codex 1", provider: "codex", terminalId: "terminal-1" },
  { id: "agent-2", name: "Claude 1", provider: "claude-code", terminalId: "terminal-2" },
];

test("queues a user message once per selected recipient", async () => {
  const writes = [];
  const events = [];
  const { createTaxChatCoordinator } = await import("../src/lib/taxChatCoordinator.ts");
  const coordinator = createTaxChatCoordinator({
    agents,
    settings: { inactivityMs: 45000, perAgentMessageLimit: 8, totalMessageLimit: 64 },
    transport: { write: async (terminalId, data) => writes.push({ terminalId, data }) },
    onEvent: (event) => events.push(event),
  });

  coordinator.start();
  await coordinator.sendUserMessage("Compare the plans.", ["agent-1", "agent-2"]);

  assert.deepEqual(writes.map((item) => item.terminalId), ["terminal-1", "terminal-2"]);
  assert.equal(events.find((event) => event.type === "message").message.kind, "user");
});

test("routes an agent block to another agent and accepts a user-directed update", async () => {
  const writes = [];
  const events = [];
  const { createTaxChatCoordinator } = await import("../src/lib/taxChatCoordinator.ts");
  const coordinator = createTaxChatCoordinator({
    agents,
    settings: { inactivityMs: 45000, perAgentMessageLimit: 8, totalMessageLimit: 64 },
    transport: { write: async (terminalId, data) => writes.push({ terminalId, data }) },
    onEvent: (event) => events.push(event),
  });

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
  const coordinator = createTaxChatCoordinator({
    agents,
    settings: { inactivityMs: 45000, perAgentMessageLimit: 1, totalMessageLimit: 1 },
    transport: { write: async () => {} },
    onEvent: (event) => events.push(event),
  });

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
  const firstWrite = new Promise((resolve) => { releaseFirst = resolve; });
  const { createTaxChatCoordinator } = await import("../src/lib/taxChatCoordinator.ts");
  const coordinator = createTaxChatCoordinator({
    agents,
    settings: { inactivityMs: 45000, perAgentMessageLimit: 8, totalMessageLimit: 64 },
    transport: {
      write: async (terminalId, data) => {
        writes.push({ terminalId, data });
        if (writes.length === 1) await firstWrite;
      },
    },
    onEvent: () => {},
  });

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
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --experimental-strip-types --test tests/taxChatCoordinator.test.mjs`

Expected: FAIL because the coordinator module does not exist.

- [ ] **Step 3: Implement the coordinator**

Implement `createTaxChatCoordinator` with these concrete rules:

```ts
export interface TaxChatAgentDescriptor {
  id: string;
  name: string;
  provider: string;
  terminalId: string;
}

export interface TaxChatTransport {
  write: (terminalId: string, data: string) => Promise<void>;
}

export type TaxChatCoordinatorEvent =
  | { type: "message"; message: TaxChatMessage }
  | { type: "status"; status: TaxChatRoomStatus; reason?: string }
  | { type: "participant"; participant: TaxChatParticipant }
  | { type: "error"; message: TaxChatMessage };

export interface TaxChatCoordinator {
  start(): void;
  pause(reason?: string): void;
  continue(): void;
  stop(): void;
  sendUserMessage(body: string, recipientIds: string[]): Promise<void>;
  handleOutput(agentId: string, chunk: string): void;
  handleAgentExit(agentId: string): void;
  snapshot(): { status: TaxChatRoomStatus; round: number; participants: TaxChatParticipant[]; messages: TaxChatMessage[] };
  dispose(): void;
}
```

Use one FIFO promise chain per recipient agent. A user message creates one transcript message and one queued delivery per valid recipient. An agent block creates one agent message and queues it for its target(s), excluding the sender for `all`. A `user` block only creates a transcript message. Increment the per-agent and total counters only for successfully parsed routed blocks, pause when either safety threshold is reached, and emit a system message explaining the limit. Reset per-round counters on `continue()` after `idle` or `paused`, but never clear `messages`. On a failed transport write, emit an error message for that agent and continue other queues. Use a single inactivity timer refreshed by each parsed or delivered message; when it fires during `running`, transition to `idle`.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `node --experimental-strip-types --test tests/taxChatCoordinator.test.mjs`

Expected: PASS for routing, serialization, lifecycle, malformed output, and safety tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/taxChatCoordinator.ts tests/taxChatCoordinator.test.mjs
git commit -m "feat: coordinate TaxChat agent messages"
```

### Task 3: Publish PTY copies for TaxChat without changing terminal rendering

**Files:**
- Modify: `src/terminal/ptyBridge.ts`
- Modify: `src/types/commands.ts` if lifecycle payload types need to be exported.
- Create: `tests/ptyBridgeOutput.test.mjs` only if a pure extracted event fan-out helper is needed.

**Interfaces:**
- Produces `subscribePtyOutput(listener: (terminalId: string, data: string) => void): () => void`.
- Produces `subscribePtyLifecycle(listener: (event: { type: "exit" | "error" | "status"; terminalId: string; message?: string }) => void): () => void`.
- Existing `startPtyBridge`, `stopPtyBridge`, and `terminalRegistry.write` behavior remains intact.

- [ ] **Step 1: Write a failing fan-out test or extract a pure helper test**

If importing `ptyBridge.ts` requires browser-only xterm setup, first extract a small `src/lib/ptyEventFanout.ts` helper and test this behavior:

```js
test("publishes output to subscribers while preserving independent terminal rendering", async () => {
  const { createPtyOutputFanout } = await import("../src/lib/ptyEventFanout.ts");
  const received = [];
  const fanout = createPtyOutputFanout();
  const unsubscribe = fanout.subscribe((terminalId, data) => received.push({ terminalId, data }));

  fanout.publish("terminal-1", "hello");
  unsubscribe();
  fanout.publish("terminal-1", "ignored");

  assert.deepEqual(received, [{ terminalId: "terminal-1", data: "hello" }]);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --experimental-strip-types --test tests/ptyBridgeOutput.test.mjs`

Expected: FAIL until the fan-out/subscription path exists.

- [ ] **Step 3: Add subscriptions at the PTY bridge boundary**

Keep `queueOutput` and `terminalRegistry.write` exactly as the rendering path. In `handleOutput`, convert byte arrays with `TextDecoder`, notify output subscribers with the decoded string, then queue the same string for xterm. Notify lifecycle subscribers from `handleStatus`, `handleExit`, and `handleError` after the existing terminal store updates. Remove all listeners in `stopPtyBridge` only for Tauri event listeners; caller subscriptions must be independently disposable and must not be lost when the bridge restarts.

- [ ] **Step 4: Run the focused test and the existing terminal tests**

Run: `node --experimental-strip-types --test tests/ptyBridgeOutput.test.mjs tests/terminalSessions.test.mjs`

Expected: PASS, with existing terminal tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/terminal/ptyBridge.ts src/types/commands.ts src/lib/ptyEventFanout.ts tests/ptyBridgeOutput.test.mjs
git commit -m "feat: expose local PTY events to TaxChat"
```

### Task 4: Wire the coordinator into a Zustand TaxChat store

**Files:**
- Create: `src/stores/taxChatStore.ts`
- Modify: `src/stores/uiStore.ts`
- Modify: `src/types/models.ts` only if store-facing settings need a shared type added.
- Create: `tests/taxChatStore.test.mjs` if the store actions can be exercised without mounting React.

**Interfaces:**
- Consumes `useAgentStore.getState().agents`, `ptyWrite`, `subscribePtyOutput`, and `subscribePtyLifecycle`.
- Produces `useTaxChatStore` with `room`, `settings`, `selectedAgentIds`, `start`, `pause`, `continueRoom`, `stop`, `send`, `setSelectedAgentIds`, and `reset`.
- Produces `useUiStore.taxChatOpen` and `setTaxChatOpen(open: boolean)`.

- [ ] **Step 1: Write failing store lifecycle tests**

```js
test("starts with available running agents and preserves transcript through pause and continue", async () => {
  const { useTaxChatStore } = await import("../src/stores/taxChatStore.ts");
  useTaxChatStore.getState().reset();
  useTaxChatStore.getState().setSelectedAgentIds(["agent-1", "agent-2"]);
  useTaxChatStore.getState().start();
  assert.equal(useTaxChatStore.getState().room?.status, "running");
  useTaxChatStore.getState().pause("user");
  const before = useTaxChatStore.getState().room?.messages.length;
  useTaxChatStore.getState().continueRoom();
  assert.equal(useTaxChatStore.getState().room?.status, "running");
  assert.equal(useTaxChatStore.getState().room?.messages.length, before);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --experimental-strip-types --test tests/taxChatStore.test.mjs`

Expected: FAIL because the store does not exist.

- [ ] **Step 3: Implement store wiring**

Use a module-level coordinator reference only for the non-serializable queues/timer; keep the serializable room snapshot in Zustand. `start()` builds descriptors from the selected IDs that still exist in `useAgentStore`, starts the coordinator, and subscribes to PTY output/lifecycle. Output callbacks map `terminalId` back to the descriptor's agent ID before calling `handleOutput`. On `reset` or `stop`, dispose the coordinator and both subscriptions. Default settings are `{ inactivityMs: 45000, perAgentMessageLimit: 8, totalMessageLimit: 64 }`. Default selected participants are all agents whose status is `starting` or `running`, filtered again at start time. If no participant is available, add a visible error message and leave the room in `ready`.

Add `taxChatOpen` to `uiStore` with a default of `false`; the store controls only visibility while `taxChatStore` controls room data.

- [ ] **Step 4: Run the focused test and existing store-adjacent tests**

Run: `node --experimental-strip-types --test tests/taxChatStore.test.mjs tests/terminalSessions.test.mjs`

Expected: PASS, with no terminal sessions created or closed by TaxChat pause/stop.

- [ ] **Step 5: Commit**

```bash
git add src/stores/taxChatStore.ts src/stores/uiStore.ts src/types/models.ts tests/taxChatStore.test.mjs
git commit -m "feat: add TaxChat room store"
```

### Task 5: Add TaxChat presentation helpers and the pane UI

**Files:**
- Create: `src/lib/taxChatPresentation.ts`
- Create: `src/components/TaxChatPanel.tsx`
- Create: `tests/taxChatPresentation.test.mjs`
- Modify: `src/index.css`

**Interfaces:**
- Consumes `TaxChatRoom`, `TaxChatMessage`, `TaxChatRoomStatus`, `TaxChatParticipant`, and provider presentation helpers.
- Produces `taxChatStatusLabel(status)`, `taxChatStatusTone(status)`, and `taxChatRecipientLabel(recipientIds, agents)`.
- Produces a keyboard-accessible `TaxChatPanel` with no prop requirement; it reads Zustand stores directly.

**Visual direction:** Use the existing ink/paper/blue system and IBM Plex Mono for compact state metadata. Make the shared transcript the memorable element: quiet surfaces, thin separators, and a small colored signal rail on agent-to-agent cards. Avoid a wall of equal rounded cards, gradients, all-caps labels, and floating overlays. Use sentence-case copy such as `Start TaxChat`, `Pause`, `Continue`, and `Send message`.

- [ ] **Step 1: Write failing presentation tests**

```js
import assert from "node:assert/strict";
import test from "node:test";

test("maps room states to user-facing labels and tones", async () => {
  const { taxChatStatusLabel, taxChatStatusTone } = await import("../src/lib/taxChatPresentation.ts");
  assert.equal(taxChatStatusLabel("running"), "Running");
  assert.equal(taxChatStatusLabel("idle"), "Idle");
  assert.equal(taxChatStatusTone("paused"), "warning");
});

test("describes recipients without exposing internal IDs", async () => {
  const { taxChatRecipientLabel } = await import("../src/lib/taxChatPresentation.ts");
  const agents = [{ id: "agent-1", name: "Codex 1" }, { id: "agent-2", name: "Claude 1" }];
  assert.equal(taxChatRecipientLabel(["agent-1"], agents), "Codex 1");
  assert.equal(taxChatRecipientLabel(["agent-1", "agent-2"], agents), "2 agents");
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --experimental-strip-types --test tests/taxChatPresentation.test.mjs`

Expected: FAIL because the presentation helper does not exist.

- [ ] **Step 3: Implement helpers and `TaxChatPanel`**

Build the panel with these regions:

1. Header: `TaxChat`, local-only badge, participant count, status pill, and lifecycle action buttons.
2. Participant strip: compact toggles for currently available agents; selected IDs update the store before starting.
3. Transcript: scrollable list with stable message keys, sender/provider labels, recipient labels, timestamps, delivery status, and distinct styles for user, agent, system, and error messages.
4. Composer: multiline input, recipient select (`All selected agents` plus individual agents), disabled state when no room is running, and `Send message` button. `Enter` sends; `Shift+Enter` inserts a newline.

The panel must show a directional empty state when no room exists: `Launch an agent, then start TaxChat to coordinate the team.` Errors must name the failed agent or action and provide the next action. Keep raw terminal output out of the transcript.

Use `aria-live="polite"` on the transcript status region, `aria-label` on recipient controls, visible keyboard focus, and a reduced-motion media query for any reveal transition. Ensure long messages wrap and the composer remains reachable when the transcript scrolls.

- [ ] **Step 4: Run helper tests and build**

Run: `node --experimental-strip-types --test tests/taxChatPresentation.test.mjs`; then `npm run build`

Expected: PASS and a successful TypeScript/Vite build.

- [ ] **Step 5: Commit**

```bash
git add src/lib/taxChatPresentation.ts src/components/TaxChatPanel.tsx src/index.css tests/taxChatPresentation.test.mjs
git commit -m "feat: add TaxChat conversation pane"
```

### Task 6: Integrate the pane beside the terminal grid and top-level controls

**Files:**
- Modify: `src/components/Workspace.tsx`
- Modify: `src/components/TopBar.tsx`
- Modify: `src/lib/chromePresentation.ts` only if a shared shell sizing helper is needed.
- Modify: `src/index.css`

**Interfaces:**
- Consumes `useUiStore.taxChatOpen`, `useUiStore.setTaxChatOpen`, and `TaxChatPanel`.
- Preserves the existing `PaneTreeView` layout tree, browser shell split, Git panel split, and terminal grid resizing.

- [ ] **Step 1: Write a failing layout/presentation regression test**

Add a pure helper only if needed to keep the panel sizing deterministic:

```js
test("uses a readable TaxChat split beside the terminal grid", async () => {
  const { taxChatShellLayout } = await import("../src/lib/chromePresentation.ts");
  assert.deepEqual(taxChatShellLayout(), {
    defaultSize: "38%",
    minSize: "320px",
    maxSize: "48%",
  });
});
```

If no helper is required, use the existing test suite plus the native smoke checklist below as the regression gate.

- [ ] **Step 2: Run the focused regression test to verify it fails**

Run: `node --experimental-strip-types --test tests/chromePresentation.test.mjs`

Expected: FAIL only if the new sizing helper is added; otherwise record the current passing baseline before layout edits.

- [ ] **Step 3: Wrap the existing terminal content in a nested horizontal group**

In `Workspace`, preserve the current `paneTree` and empty states. When `taxChatOpen` and a pane tree exist, render:

```tsx
<Group orientation="horizontal" className="h-full min-h-0 min-w-0">
  <Panel id="taxchat-terminals" minSize="320px" defaultSize="62%" className="min-h-0 min-w-0">
    {existingTerminalWorkspace}
  </Panel>
  <Separator className="pane-handle pane-handle-h" />
  <Panel id="taxchat" minSize="320px" maxSize="48%" defaultSize="38%" className="min-h-0 min-w-0">
    <TaxChatPanel />
  </Panel>
</Group>
```

When closed, render the existing terminal workspace unchanged. Add one topbar action labelled `TaxChat` that toggles `taxChatOpen`, is disabled when there are no running/starting agents, and exposes `aria-pressed`. Do not route TaxChat through the browser panel or create a second native window.

- [ ] **Step 4: Run tests, lint, and build**

Run: `node --experimental-strip-types --test tests/*.test.mjs`; `npm run lint`; `npm run build`

Expected: all tests pass, ESLint reports no errors, and the production build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/components/Workspace.tsx src/components/TopBar.tsx src/lib/chromePresentation.ts src/index.css tests/chromePresentation.test.mjs
git commit -m "feat: dock TaxChat beside the terminal grid"
```

### Task 7: Verify the complete local desktop flow

**Files:**
- Modify: none unless verification reveals a concrete defect.
- Test: all existing `tests/*.test.mjs` plus the native Tauri smoke flow.

**Interfaces:**
- Consumes the completed TaxChat UI, store, coordinator, and PTY bridge.
- Produces verified desktop behavior and a clean committed branch.

- [ ] **Step 1: Run the complete automated verification**

Run:

```powershell
node --experimental-strip-types --test tests/*.test.mjs
npm run lint
npm run build
```

Expected: all Node tests pass, ESLint exits successfully, and the Vite/TypeScript build completes.

- [ ] **Step 2: Run the Tauri desktop smoke test**

Run: `npm run tauri dev`

Verify manually:

1. Open a repository and launch at least two local agents.
2. Open TaxChat from the top bar; confirm it docks beside the terminal grid rather than appearing over it.
3. Resize TaxChat and confirm both the transcript and terminal grid remain usable.
4. Select recipients, send a user message, and confirm one tagged delivery reaches each selected terminal.
5. Emit a valid `[[TAXCHAT:to=...]]` block from an agent and confirm it appears in TaxChat and routes to the requested agent.
6. Confirm ordinary terminal output remains in the terminal and is not duplicated as chat.
7. Pause, Continue, and Stop; confirm terminal processes remain open.
8. Close one agent; confirm it becomes unavailable while the remaining agent remains usable.
9. Open the browser; confirm it remains the outer right-side panel and does not cover TaxChat.
10. Stop the dev app cleanly and confirm no unexpected files changed.

- [ ] **Step 3: Review the final diff and commit verification-only fixes**

Run: `git diff --check`; `git status --short --branch`; `git log --oneline -8`

Expected: no whitespace errors, only intended TaxChat changes, and all feature commits present on the isolated branch.

---

## Plan self-review

- Spec coverage: protocol and malformed-output behavior are Task 1; smart rounds, queues, limits, lifecycle, and failures are Task 2; PTY preservation is Task 3; local store wiring is Task 4; transcript/composer/UI behavior is Task 5; pane placement and browser coexistence are Task 6; acceptance flow and automated verification are Task 7.
- Placeholder scan: no step relies on an undefined follow-up or an unspecified validation action; the only conditional is the testable choice to extract a pure PTY fan-out helper if browser-only imports prevent direct bridge testing.
- Type consistency: Task 1 defines the models consumed by Tasks 2, 4, and 5; Task 2 defines the coordinator and transport interfaces consumed by Task 4; Task 3 defines the subscription signatures consumed by Task 4; Task 5 defines the pane consumed by Task 6.
- Visual review: the design uses the existing Taxzy dark/light tokens and typography, gives the transcript one intentional signal-rail accent, and keeps the terminal/browser split model unchanged.
