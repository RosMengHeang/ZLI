import assert from "node:assert/strict";
import test from "node:test";

test("pending terminal lifecycle remembers an exit until the session is registered", async () => {
  const { createPendingTerminalLifecycle } = await import("../src/lib/pendingTerminalLifecycle.ts");
  const pending = createPendingTerminalLifecycle(() => 1000);

  pending.remember("terminal-1", { status: "exited", exitCode: 7 });

  assert.deepEqual(pending.take("terminal-1"), { status: "exited", exitCode: 7 });
  assert.equal(pending.take("terminal-1"), null);
});

test("pending terminal lifecycle is bounded and expires stale entries", async () => {
  let now = 1000;
  const { createPendingTerminalLifecycle } = await import("../src/lib/pendingTerminalLifecycle.ts");
  const pending = createPendingTerminalLifecycle(() => now, { maxEntries: 2, ttlMs: 50 });

  pending.remember("terminal-1", { status: "error", message: "failed" });
  pending.remember("terminal-2", { status: "exited", exitCode: null });
  pending.remember("terminal-3", { status: "exited", exitCode: 1 });
  assert.equal(pending.size(), 2);
  assert.equal(pending.take("terminal-1"), null);

  now += 51;
  assert.equal(pending.take("terminal-2"), null);
  assert.equal(pending.size(), 0);
});
