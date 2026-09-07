import assert from "node:assert/strict";
import test from "node:test";

test("maps process state to text, semantic tone, and motion", async () => {
  const { statusPresentation } = await import("../src/lib/statusPresentation.ts");
  assert.deepEqual(statusPresentation("running"), { label: "Running", tone: "success", animated: true });
  assert.deepEqual(statusPresentation("starting"), { label: "Starting", tone: "warning", animated: true });
  assert.deepEqual(statusPresentation("failed"), { label: "Failed", tone: "danger", animated: false });
  assert.deepEqual(statusPresentation("stopped"), { label: "Stopped", tone: "neutral", animated: false });
});
