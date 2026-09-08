import assert from "node:assert/strict";
import test from "node:test";

test("maps process state without advertising decorative animation", async () => {
  const { statusPresentation } = await import("../src/lib/statusPresentation.ts");
  assert.deepEqual(statusPresentation("running"), { label: "Running", tone: "success", animated: false });
  assert.deepEqual(statusPresentation("starting"), { label: "Starting", tone: "warning", animated: false });
  assert.deepEqual(statusPresentation("failed"), { label: "Failed", tone: "danger", animated: false });
  assert.deepEqual(statusPresentation("stopped"), { label: "Stopped", tone: "neutral", animated: false });
});
