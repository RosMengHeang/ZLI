import assert from "node:assert/strict";
import test from "node:test";

test("normalizes stored theme values", async () => {
  const { normalizeThemeMode } = await import("../src/lib/theme.ts");
  assert.equal(normalizeThemeMode("light"), "light");
  assert.equal(normalizeThemeMode("dark"), "dark");
  assert.equal(normalizeThemeMode("system"), "system");
  assert.equal(normalizeThemeMode("sepia"), "system");
  assert.equal(normalizeThemeMode(null), "system");
});

test("resolves system appearance without changing explicit choices", async () => {
  const { resolveTheme } = await import("../src/lib/theme.ts");
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(resolveTheme("light", true), "light");
});
