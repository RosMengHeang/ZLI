import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

test("preferences exposes the built-in browser control setting", async () => {
  const [preferences, store, status] = await Promise.all([
    readFile(path.join(projectRoot, "src/components/PreferencesDialog.tsx"), "utf8"),
    readFile(path.join(projectRoot, "src/stores/browserStore.ts"), "utf8"),
    readFile(path.join(projectRoot, "src/components/BrowserControlStatus.tsx"), "utf8"),
  ]);

  assert.match(preferences, /Built-in browser control/);
  assert.match(preferences, /setControlEnabled/);
  assert.match(preferences, /type="checkbox"/);
  assert.match(store, /refreshControlStatus/);
  assert.match(store, /setControlEnabled/);
  assert.match(status, /Browser control/);
});
