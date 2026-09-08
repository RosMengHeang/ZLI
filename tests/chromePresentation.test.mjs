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
  assert.deepEqual(SHELL_LIMITS.browser, { default: "34%", min: "360px", max: "50%" });
  assert.deepEqual(SHELL_LIMITS.git, { default: "34%", min: "220px", max: "68%" });
});

test("presents all four primary destinations with Agents selectable", async () => {
  const { sidebarNavigationItems } = await import("../src/lib/chromePresentation.ts");
  assert.deepEqual(sidebarNavigationItems?.("agents"), [
    { id: "workspace", label: "Workspace", current: false },
    { id: "agents", label: "Agents", current: true },
    { id: "changes", label: "Changes", current: false },
    { id: "browser", label: "Browser", current: false },
  ]);
});

test("navigating to Agents closes inspectors and selects the first agent", async () => {
  const { navigationTargetForDestination } = await import("../src/lib/chromePresentation.ts");
  assert.deepEqual(navigationTargetForDestination?.("agents", ["agent-1", "agent-2"]), {
    baseDestination: "agents",
    browserOpen: false,
    gitPanelOpen: false,
    selectedAgentId: "agent-1",
  });
});

test("presents aggregate running state with a visible semantic label", async () => {
  const { aggregateRunningStatus } = await import("../src/lib/chromePresentation.ts");
  assert.deepEqual(aggregateRunningStatus?.(2), {
    label: "2 running",
    presentedStatus: "running",
  });
  assert.deepEqual(aggregateRunningStatus?.(0), {
    label: "Idle",
    presentedStatus: "stopped",
  });
});

test("uses unit-aware defaults while retaining stored percentage layouts", async () => {
  const { defaultShellSize } = await import("../src/lib/chromePresentation.ts");
  assert.equal(defaultShellSize?.("sidebar", undefined), "228px");
  assert.equal(defaultShellSize?.("sidebar", 22), "22%");
  assert.equal(defaultShellSize?.("browser", undefined), "34%");
});

test("keeps the browser split on the right and normalizes native view bounds", async () => {
  const { browserShellLayout, nativeBrowserBounds, nativeBrowserHiddenBounds, nativeBrowserRectIsUsable } = await import("../src/lib/chromePresentation.ts");
  assert.deepEqual(browserShellLayout?.(), {
    side: "right",
    defaultSize: "34%",
    minSize: "360px",
    maxSize: "50%",
  });
  assert.deepEqual(nativeBrowserBounds?.({ left: 612.6, top: 52.4, width: 488.4, height: 700.6 }), {
    x: 613,
    y: 52,
    width: 488,
    height: 701,
  });
  assert.deepEqual(nativeBrowserBounds?.({ left: -3, top: -2, width: 0, height: -1 }), {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  });
  assert.deepEqual(nativeBrowserHiddenBounds?.(), {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  });
  assert.equal(nativeBrowserRectIsUsable?.(
    { left: 612, top: 52, width: 488, height: 701 },
    { width: 1280, height: 800 },
  ), true);
  assert.equal(nativeBrowserRectIsUsable?.(
    { left: -1, top: 52, width: 488, height: 701 },
    { width: 1280, height: 800 },
  ), false);
  assert.equal(nativeBrowserRectIsUsable?.(
    { left: 900, top: 52, width: 488, height: 701 },
    { width: 1280, height: 800 },
  ), false);
});

test("uses a readable TaxChat split beside the terminal grid", async () => {
  const { taxChatShellLayout } = await import("../src/lib/chromePresentation.ts");
  assert.deepEqual(taxChatShellLayout(), {
    defaultSize: "38%",
    minSize: "320px",
    maxSize: "48%",
    terminalMinSize: "0%",
  });
});
