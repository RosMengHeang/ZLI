import assert from "node:assert/strict";
import test from "node:test";
test("busy or protected dialogs cannot dismiss incidentally", async () => {
  const { canDismissDialog } = await import("../src/lib/dialogBehavior.ts");
  assert.equal(canDismissDialog({ dismissible: true, busy: false }), true);
  assert.equal(canDismissDialog({ dismissible: true, busy: true }), false);
  assert.equal(canDismissDialog({ dismissible: false, busy: false }), false);
});
test("changed files have readable status labels", async () => {
  const { changedFileLabel } = await import("../src/lib/gitPresentation.ts");
  for (const [status, expected] of [["M", "Modified"], ["added", "Added"], ["?", "Untracked"], ["unmerged", "Conflict"], ["unknown", "Changed"]]) {
    assert.equal(changedFileLabel({status, path: "src/App.tsx"}), `${expected}: src/App.tsx`);
  }
});
