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
  assert.equal(defaultShellSize?.("browser", undefined), "30%");
});
