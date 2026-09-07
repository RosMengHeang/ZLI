import assert from "node:assert/strict";
import test from "node:test";

test("classifies and windows large diffs without walking every line in the viewport", async () => {
  const { classifyDiffLine, parseDiffLines, visibleDiffRange, MAX_DIFF_LINES } = await import(
    "../src/lib/diffView.ts"
  );

  assert.equal(classifyDiffLine("diff --git a/a b/a"), "meta");
  assert.equal(classifyDiffLine("+++ b/a"), "header");
  assert.equal(classifyDiffLine("@@ -1,2 +1,3 @@"), "hunk");
  assert.equal(classifyDiffLine("+added"), "add");
  assert.equal(classifyDiffLine("-removed"), "del");
  assert.equal(classifyDiffLine(" context"), "ctx");

  const diff = Array.from({ length: 500 }, (_, index) => `+line ${index}`).join("\n");
  const lines = parseDiffLines(diff);
  assert.equal(lines.length, 500);
  assert.equal(lines[0].kind, "add");

  const range = visibleDiffRange(180, 90, 500, 18, 2);
  assert.equal(range.start, 8);
  assert.ok(range.end < 30);
  assert.ok(MAX_DIFF_LINES > 1000);
});

test("debounce coalesces bursts and can be cancelled", async () => {
  const { debounce } = await import("../src/lib/schedule.ts");
  let count = 0;
  const fn = debounce(() => {
    count += 1;
  }, 20);
  fn();
  fn();
  fn();
  assert.equal(count, 0);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(count, 1);
  fn();
  fn.cancel();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(count, 1);
});

test("omits plus/minus when git line counts are unavailable", async () => {
  const { formatPlusMinus } = await import("../src/lib/format.ts");
  assert.equal(formatPlusMinus(null, null), "");
  assert.equal(formatPlusMinus(3, 1), "+3 −1");
  assert.equal(formatPlusMinus(0, 4), "+0 −4");
});
