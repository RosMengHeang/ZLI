import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentSettingsStore } from "./AgentSettingsStore.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("AgentSettingsStore", () => {
  it("keeps the file and the settings in step when saves overlap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zli-agent-settings-"));
    dirs.push(dir);
    const path = join(dir, "agent-settings.json");
    const store = new AgentSettingsStore(path);
    const saves = await Promise.all([
      store.save({ claudeAutoCompactTokens: 100_000 }),
      store.save({ claudeAutoCompactTokens: 200_000 }),
      store.save({ claudeAutoCompactTokens: 300_000 }),
    ]);
    expect(saves.map((saved) => saved.claudeAutoCompactTokens)).toEqual([100_000, 200_000, 300_000]);
    expect(store.read().claudeAutoCompactTokens).toBe(300_000);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ claudeAutoCompactTokens: 300_000 });
    // No temporary file is left behind.
    expect(await readdir(dir)).toEqual(["agent-settings.json"]);
  });
});
