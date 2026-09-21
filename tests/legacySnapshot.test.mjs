import test from "node:test";
import assert from "node:assert/strict";

import { buildLegacySnapshot } from "../src/lib/legacySnapshot.ts";

test("legacy snapshot export is allowlisted and preserves malformed values safely", () => {
  const values = new Map([
    ["zli:workspace-registry", JSON.stringify({ workspaces: [{ root: "C:/repo" }] })],
    ["zli:browser-permissions", JSON.stringify({ profiles: [] })],
    ["zli:last-project-path", "C:/repo"],
    ["zli:secret", "must-not-export"],
  ]);
  const snapshot = buildLegacySnapshot({ getItem: (key) => values.get(key) ?? null });
  assert.equal(snapshot.format, "zli-legacy-snapshot");
  assert.deepEqual(snapshot.workspaceRegistry, { workspaces: [{ root: "C:/repo" }] });
  assert.deepEqual(snapshot.browserPermissions, { profiles: [] });
  assert.equal(snapshot.lastProjectPath, "C:/repo");
  assert.equal(JSON.stringify(snapshot).includes("must-not-export"), false);
});
