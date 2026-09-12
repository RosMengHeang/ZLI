import assert from "node:assert/strict";
import test from "node:test";

test("browser bridge uses typed surface lifecycle commands", async () => {
  const { createBrowserBridge } = await import("../src/lib/browser/browserBridge.ts");
  const calls = [];
  const bridge = createBrowserBridge(async (command, args) => {
    calls.push({ command, args });
    return { surfaceId: "surface-1" };
  });
  const request = {
    projectId: "project-1",
    agentId: null,
    webviewLabel: "browser-panel-1",
    url: "about:blank",
    profileId: "default",
  };

  await bridge.register(request);
  await bridge.createPanel({
    label: "browser-panel-1",
    url: "about:blank",
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  });
  await bridge.rejectOpen("open-1");
  await bridge.navigation("surface-1", "https://example.com");
  await bridge.grant("surface-1", "browser.read");
  await bridge.revoke("surface-1", "browser.read");
  await bridge.close("surface-1");

  assert.deepEqual(calls, [
    { command: "browser_register_surface", args: { request } },
    {
      command: "browser_create_panel_webview",
      args: {
        request: {
          label: "browser-panel-1",
          url: "about:blank",
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        },
      },
    },
    { command: "browser_reject_open", args: { requestId: "open-1" } },
    { command: "browser_update_navigation", args: { surfaceId: "surface-1", url: "https://example.com" } },
    { command: "browser_grant_capability", args: { surfaceId: "surface-1", capability: "browser.read" } },
    { command: "browser_revoke_capability", args: { surfaceId: "surface-1", capability: "browser.read" } },
    { command: "browser_close_surface", args: { surfaceId: "surface-1" } },
  ]);
});

test("browser bridge reads and updates the built-in control setting", async () => {
  const { createBrowserBridge } = await import("../src/lib/browser/browserBridge.ts");
  const calls = [];
  const bridge = createBrowserBridge(async (command, args) => {
    calls.push({ command, args });
    return { profileId: "clean", enabled: true, surfaceCount: 0, bridgeAvailable: true };
  });

  await bridge.controlStatus("clean");
  await bridge.setControlEnabled("clean", true);

  assert.deepEqual(calls, [
    { command: "browser_control_status", args: { profileId: "clean" } },
    { command: "browser_control_set", args: { profileId: "clean", enabled: true } },
  ]);
});
