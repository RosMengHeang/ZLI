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
