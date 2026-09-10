import assert from "node:assert/strict";
import test from "node:test";

test("maps process state without advertising decorative animation", async () => {
  const { statusPresentation } = await import("../src/lib/statusPresentation.ts");
  assert.deepEqual(statusPresentation("running"), { label: "Running", tone: "success", animated: false });
  assert.deepEqual(statusPresentation("starting"), { label: "Starting", tone: "warning", animated: false });
  assert.deepEqual(statusPresentation("failed"), { label: "Failed", tone: "danger", animated: false });
  assert.deepEqual(statusPresentation("stopped"), { label: "Stopped", tone: "neutral", animated: false });
});

test("presents all six attention states with text and restrained semantic tones", async () => {
  const { attentionStatusPresentation } = await import("../src/lib/statusPresentation.ts");
  assert.deepEqual(attentionStatusPresentation("working"), { label: "Working", tone: "success", animated: false });
  assert.deepEqual(attentionStatusPresentation("waiting_for_you"), { label: "Waiting for you", tone: "warning", animated: false });
  assert.deepEqual(attentionStatusPresentation("completed"), { label: "Completed", tone: "success", animated: false });
  assert.deepEqual(attentionStatusPresentation("failed"), { label: "Failed", tone: "danger", animated: false });
  assert.deepEqual(attentionStatusPresentation("paused"), { label: "Paused", tone: "warning", animated: false });
  assert.deepEqual(attentionStatusPresentation("offline"), { label: "Offline", tone: "neutral", animated: false });
});
