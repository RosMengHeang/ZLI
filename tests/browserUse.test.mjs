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
    "browser_get_state",
    "browser_type",
    "browser_extract_content",
    "browser_list_tabs",
    "browser_go_back",
    "browser_scroll",
  ]);
  assert.equal(isBrowserUseTool("browser_snapshot"), true);
  assert.equal(isBrowserUseTool("shell_exec"), false);
  assert.equal(browserUseControlMethod("browser_snapshot"), "browser.snapshot");
  assert.equal(browserUseControlMethod("browser_get_state"), "browser.snapshot");
  assert.equal(browserUseControlMethod("browser_type"), "browser.fill");
  assert.equal(browserUseControlMethod("browser_extract_content"), "browser.snapshot");
  assert.equal(browserUseControlMethod("browser_list_tabs"), "browser.list");
  assert.equal(browserUseControlMethod("browser_go_back"), "browser.go_back");
  assert.equal(browserUseControlMethod("browser_scroll"), "browser.scroll");
});
