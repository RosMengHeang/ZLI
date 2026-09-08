import assert from "node:assert/strict";
import test from "node:test";

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

test("publishes lifecycle events to independent subscribers", async () => {
  const { createPtyLifecycleFanout } = await import("../src/lib/ptyEventFanout.ts");
  const received = [];
  const fanout = createPtyLifecycleFanout();
  fanout.subscribe((event) => received.push(event));

  fanout.publish({ type: "exit", terminalId: "terminal-1" });
  fanout.publish({ type: "error", terminalId: "terminal-2", message: "broken" });

  assert.deepEqual(received, [
    { type: "exit", terminalId: "terminal-1" },
    { type: "error", terminalId: "terminal-2", message: "broken" },
  ]);
});
