import assert from "node:assert/strict";
import test from "node:test";

test("uses compact toolbar chrome below the full desktop width", async () => {
  const { toolbarDensityForWidth } = await import("../src/lib/chromePresentation.ts");
  assert.equal(toolbarDensityForWidth(900), "compact");
  assert.equal(toolbarDensityForWidth(1099), "compact");
  assert.equal(toolbarDensityForWidth(1100), "comfortable");
});

test("publishes pixel-safe shell limits", async () => {
  const { SHELL_LIMITS } = await import("../src/lib/chromePresentation.ts");
  assert.deepEqual(SHELL_LIMITS.sidebar, { default: "228px", min: "196px", max: "300px" });
  assert.deepEqual(SHELL_LIMITS.browser, { default: "30%", min: "320px", max: "48%" });
  assert.deepEqual(SHELL_LIMITS.git, { default: "34%", min: "220px", max: "68%" });
});
