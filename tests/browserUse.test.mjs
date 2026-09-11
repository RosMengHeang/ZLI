import assert from "node:assert/strict";
import test from "node:test";

test("browser use keeps one provider-neutral tool catalog", async () => {
  const { BROWSER_USE_TOOLS, browserUseControlMethod, isBrowserUseTool } = await import("../src/control/browserUse.ts");

  assert.deepEqual(BROWSER_USE_TOOLS, [
    "browser_status",
    "browser_open",
    "browser_navigate",
    "browser_wait",
    "browser_snapshot",
    "browser_click",
    "browser_fill",
    "browser_press",
    "browser_console",
    "browser_errors",
    "browser_screenshot",
  ]);
  assert.equal(isBrowserUseTool("browser_snapshot"), true);
  assert.equal(isBrowserUseTool("shell_exec"), false);
  assert.equal(browserUseControlMethod("browser_snapshot"), "browser.snapshot");
});
