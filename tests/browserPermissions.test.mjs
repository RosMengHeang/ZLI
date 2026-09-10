import assert from "node:assert/strict";
import test from "node:test";

test("browser interaction remains disabled until explicitly granted per project", async () => {
  const {
    capabilitiesFor,
    EMPTY_BROWSER_PERMISSIONS,
    setBrowserCapability,
  } = await import("../src/lib/browser/browserPermissions.ts");

  assert.deepEqual(capabilitiesFor(EMPTY_BROWSER_PERMISSIONS, "project-1", "default"), []);
  const readOnly = setBrowserCapability(
    EMPTY_BROWSER_PERMISSIONS,
    "project-1",
    "default",
    "browser.read",
    true,
  );
  assert.deepEqual(capabilitiesFor(readOnly, "project-1", "default"), ["browser.read"]);
  assert.deepEqual(capabilitiesFor(readOnly, "project-2", "default"), []);
  assert.equal(capabilitiesFor(readOnly, "project-1", "default").includes("browser.control"), false);
});

test("browser permission persistence drops unsupported capabilities and secret fields", async () => {
  const { normalizeBrowserPermissions } = await import("../src/lib/browser/browserPermissions.ts");
  const normalized = normalizeBrowserPermissions({
    profiles: [{
      projectId: "project-1",
      profileId: "default",
      capabilities: ["browser.read", "browser.download", "browser.read"],
      cookies: "secret",
      storage: { token: "secret" },
    }],
  });
  assert.deepEqual(normalized, {
    profiles: [{ projectId: "project-1", profileId: "default", capabilities: ["browser.read"] }],
  });
  const encoded = JSON.stringify(normalized);
  assert.equal(encoded.includes("secret"), false);
  assert.equal(encoded.includes("cookie"), false);
});

test("browser automation status follows only the active project", async () => {
  const { useBrowserStore } = await import("../src/stores/browserStore.ts");
  useBrowserStore.setState({
    surface: {
      surfaceId: "surface-1",
      projectId: "project-1",
      agentId: null,
      url: "about:blank",
      profileId: "default",
      capabilities: [],
      createdAt: "2026-01-01T00:00:00Z",
    },
    automation: null,
  });
  useBrowserStore.getState().applyEvent({
    schemaVersion: 1,
    sequence: 1,
    eventId: "event-1",
    projectId: "project-2",
    agentId: null,
    parentAgentId: null,
    timestamp: "2026-01-01T00:00:00Z",
    source: "browser",
    kind: "browser_command_started",
    payload: { type: "text", text: "snapshot" },
  });
  assert.equal(useBrowserStore.getState().automation, null);
  useBrowserStore.getState().applyEvent({
    schemaVersion: 1,
    sequence: 2,
    eventId: "event-2",
    projectId: "project-1",
    agentId: null,
    parentAgentId: null,
    timestamp: "2026-01-01T00:00:01Z",
    source: "browser",
    kind: "browser_command_started",
    payload: { type: "text", text: "snapshot" },
  });
  assert.deepEqual(useBrowserStore.getState().automation, { phase: "running", operation: "snapshot" });
});
