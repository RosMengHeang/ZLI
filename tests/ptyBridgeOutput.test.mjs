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

test("streaming TextDecoder reassembles a split multibyte prompt marker", async () => {
  const { decodeTerminalBytes, flushTerminalDecoder } = await import(
    "../src/terminal/ptyBridgeHelpers.ts"
  );
  const bytes = new TextEncoder().encode("❯");
  assert.equal(bytes.length, 3);
  const decoders = new Map();
  const first = decodeTerminalBytes(decoders, "t1", bytes.slice(0, 2));
  const second = decodeTerminalBytes(decoders, "t1", bytes.slice(2));
  assert.equal(first, "");
  assert.equal(second, "❯");
  assert.equal(first.includes("\uFFFD"), false);
  assert.equal(second.includes("\uFFFD"), false);
  assert.equal(flushTerminalDecoder(decoders, "t1"), "");
});

test("bindPtyListeners unlistens collected handlers when a later listen fails", async () => {
  const { bindPtyListeners } = await import("../src/terminal/ptyBridgeHelpers.ts");
  const unlistened = [];
  let calls = 0;
  const listenFn = async (name) => {
    calls += 1;
    const unlisten = () => {
      unlistened.push(name);
    };
    if (calls === 3) {
      throw new Error("listener unavailable");
    }
    return unlisten;
  };

  await assert.rejects(
    () =>
      bindPtyListeners(listenFn, {
        onOutput() {},
        onStatus() {},
        onExit() {},
        onError() {},
      }),
    /listener unavailable/,
  );
  assert.equal(unlistened.length, 2);
  assert.equal(calls, 3);
});
