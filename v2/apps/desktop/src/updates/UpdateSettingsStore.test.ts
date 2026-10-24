import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseUpdateSettings, UpdateSettingsStore } from "./UpdateSettingsStore.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("update settings", () => {
  it("installs updates automatically by default and drops malformed fields", () => {
    expect(parseUpdateSettings(undefined)).toEqual({ autoInstall: true });
    expect(
      parseUpdateSettings({ autoInstall: "no", lastSeenVersion: "latest", offered: { version: "1.2.3", notes: 4 } }),
    ).toEqual({ autoInstall: true, offered: { version: "1.2.3" } });
  });

  it("saves changes and reads them back, falling back to defaults for a broken file", async () => {
    const root = await mkdtemp(join(tmpdir(), "zli-updates-"));
    roots.push(root);
    const path = join(root, "settings", "updates.json");
    const store = new UpdateSettingsStore(path);
    expect(await store.load()).toEqual({ autoInstall: true });

    await store.update({ autoInstall: false, lastSeenVersion: "0.2.0" });
    await store.update({ offered: { version: "0.3.0", notes: "Fixes" } });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      autoInstall: false,
      lastSeenVersion: "0.2.0",
      offered: { version: "0.3.0", notes: "Fixes" },
    });
    expect((await new UpdateSettingsStore(path).load()).autoInstall).toBe(false);

    await writeFile(path, "{not json", "utf8");
    expect(await new UpdateSettingsStore(path).load()).toEqual({ autoInstall: true });
  });
});
