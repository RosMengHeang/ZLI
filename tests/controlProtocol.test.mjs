import assert from "node:assert/strict";
import test from "node:test";

test("control protocol decodes success and preserves stable server errors", async () => {
  const { ControlClientError, decodeControlResponse } = await import("../src/control/protocol.ts");
  const success = decodeControlResponse({
    id: "req-1",
    protocolVersion: 1,
    ok: true,
    result: { agents: [] },
  });
  assert.deepEqual(success, {
    id: "req-1",
    protocolVersion: 1,
    ok: true,
    result: { agents: [] },
  });

  assert.throws(
    () => decodeControlResponse({
      id: "req-2",
      protocolVersion: 1,
      ok: false,
      error: { code: "CAPABILITY_DENIED", message: "Agent cannot discard worktrees" },
    }),
    (error) => error instanceof ControlClientError
      && error.code === "CAPABILITY_DENIED"
      && error.message === "Agent cannot discard worktrees",
  );
});

test("control protocol rejects malformed envelopes and unsupported versions", async () => {
  const { decodeControlResponse } = await import("../src/control/protocol.ts");
  for (const malformed of [
    null,
    { id: "", protocolVersion: 1, ok: true, result: {} },
    { id: "req", protocolVersion: 2, ok: true, result: {} },
    { id: "req", protocolVersion: 1, ok: false },
    { id: "req", protocolVersion: 1, ok: false, error: { code: "", message: "bad" } },
    { id: "req", protocolVersion: 1, ok: true, result: {}, error: { code: "CAPABILITY_DENIED", message: "bad" } },
    { id: "req", protocolVersion: 1, ok: false, result: {}, error: { code: "CAPABILITY_DENIED", message: "bad" } },
  ]) {
    assert.throws(() => decodeControlResponse(malformed), /Invalid control response|protocol/i);
  }
});
