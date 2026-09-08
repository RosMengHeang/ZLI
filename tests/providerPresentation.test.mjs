import assert from "node:assert/strict";
import test from "node:test";

test("Claude CLI aliases resolve to the Claude product identity", async () => {
  const presentation = await import("../src/lib/providerPresentation.ts").catch(() => ({}));

  assert.equal(typeof presentation.providerVisualIdentity, "function");
  for (const id of ["claude-code", "claude"]) {
    assert.deepEqual(presentation.providerVisualIdentity(id), {
      mark: "claude",
      label: "Claude Code",
      accent: "#D97757",
    });
  }
});
