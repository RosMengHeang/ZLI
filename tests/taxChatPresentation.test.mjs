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
  const agents = [
    { id: "agent-1", name: "Codex 1" },
    { id: "agent-2", name: "Claude 1" },
  ];
  assert.equal(taxChatRecipientLabel(["agent-1"], agents), "Codex 1");
  assert.equal(taxChatRecipientLabel(["agent-1", "agent-2"], agents), "2 agents");
});
