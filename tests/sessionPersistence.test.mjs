import assert from "node:assert/strict";
import test from "node:test";

const validCheckpoint = {
  schemaVersion: 1,
  projectId: "project-1",
  agents: [],
  paneTree: null,
  browser: [],
  taxChatRoom: null,
  lastEventSequence: 42,
  savedAt: "2026-09-10T09:30:00.000Z",
};

test("session persistence accepts a complete version 1 checkpoint", async () => {
  const { decodeSessionCheckpoint, isSessionCheckpoint } = await import(
    "../src/lib/sessionPersistence.ts"
  );

  assert.equal(isSessionCheckpoint(validCheckpoint), true);
  assert.deepEqual(decodeSessionCheckpoint(validCheckpoint), {
    ok: true,
    value: validCheckpoint,
  });
});

test("session persistence rejects unsupported schemas, empty IDs, and invalid timestamps", async () => {
  const { decodeSessionCheckpoint, isSessionCheckpoint } = await import(
    "../src/lib/sessionPersistence.ts"
  );
  const invalidCheckpoints = [
    { ...validCheckpoint, schemaVersion: 2 },
    { ...validCheckpoint, projectId: "" },
    { ...validCheckpoint, projectId: "   " },
    { ...validCheckpoint, savedAt: "yesterday" },
    { ...validCheckpoint, savedAt: "2026-02-30T09:30:00Z" },
  ];

  for (const checkpoint of invalidCheckpoints) {
    assert.equal(isSessionCheckpoint(checkpoint), false);
    const result = decodeSessionCheckpoint(checkpoint);
    assert.equal(result.ok, false);
    assert.equal(typeof result.error.code, "string");
  }
});

test("session persistence decoder bounds malformed payload errors", async () => {
  const { decodeSessionCheckpoint } = await import("../src/lib/sessionPersistence.ts");
  const payload = { secret: "do-not-echo", nested: { value: "x".repeat(10_000) } };

  const result = decodeSessionCheckpoint(payload);

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "invalid_session_checkpoint",
      message: "Session checkpoint is invalid",
    },
  });
  assert.equal(JSON.stringify(result).includes("do-not-echo"), false);
});
