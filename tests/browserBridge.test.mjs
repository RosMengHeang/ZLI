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
  await bridge.navigation("surface-1", "https://example.com");
  await bridge.grant("surface-1", "browser.read");
  await bridge.revoke("surface-1", "browser.read");
  await bridge.close("surface-1");

  assert.deepEqual(calls, [
    { command: "browser_register_surface", args: { request } },
    { command: "browser_update_navigation", args: { surfaceId: "surface-1", url: "https://example.com" } },
    { command: "browser_grant_capability", args: { surfaceId: "surface-1", capability: "browser.read" } },
    { command: "browser_revoke_capability", args: { surfaceId: "surface-1", capability: "browser.read" } },
    { command: "browser_close_surface", args: { surfaceId: "surface-1" } },
  ]);
});
