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
