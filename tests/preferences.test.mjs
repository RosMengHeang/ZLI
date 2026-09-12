import assert from "node:assert/strict";
import test from "node:test";

function installStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  globalThis.localStorage = {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
  };
  return store;
}

test("preference reads migrate taxzy keys into zli keys once", async () => {
  const store = installStorage({
    "taxzy:last-project-path": "D:/legacy-project",
    "taxzy:setup-dismissed": "1",
    "taxzy:theme-mode": "light",
  });

  const {
    getLastProjectPath,
    wasSetupDismissed,
    getThemePreference,
    setLastProjectPath,
    THEME_MODE_KEY,
  } = await import("../src/lib/preferences.ts");

  assert.equal(getLastProjectPath(), "D:/legacy-project");
  assert.equal(wasSetupDismissed(), true);
  assert.equal(getThemePreference(), "light");
  assert.equal(store.get("zli:last-project-path"), "D:/legacy-project");
  assert.equal(store.has("taxzy:last-project-path"), false);
  assert.equal(store.get("zli:setup-dismissed"), "1");
  assert.equal(store.has("taxzy:setup-dismissed"), false);
  assert.equal(store.get(THEME_MODE_KEY), "light");
  assert.equal(store.has("taxzy:theme-mode"), false);

  setLastProjectPath("D:/new-project");
  assert.equal(store.get("zli:last-project-path"), "D:/new-project");
  assert.equal(store.has("taxzy:last-project-path"), false);
});

test("preference reads prefer existing zli keys over legacy taxzy keys", async () => {
  installStorage({
    "zli:last-project-path": "D:/current",
    "taxzy:last-project-path": "D:/stale",
  });

  const { getLastProjectPath } = await import("../src/lib/preferences.ts");
  assert.equal(getLastProjectPath(), "D:/current");
});
