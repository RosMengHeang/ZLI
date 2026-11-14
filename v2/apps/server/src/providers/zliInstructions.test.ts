import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentSettingsStore } from "./AgentSettingsStore.js";
import { writeZliInstructions, zliInstructions } from "./zliInstructions.js";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zli-instructions-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("zliInstructions", () => {
  it("mentions the browser tools only when the chat has them", () => {
    expect(zliInstructions({ browserTool: true })).toContain("zli-browser");
    expect(zliInstructions({ browserTool: false })).not.toContain("zli-browser");
    expect(zliInstructions({ browserTool: false })).toContain("`src/app.ts:42`");
  });

  it("writes one file per variant and returns its path", async () => {
    const dir = await tempDir();
    const path = await writeZliInstructions(dir, { browserTool: true });
    expect(await readFile(path, "utf8")).toBe(zliInstructions({ browserTool: true }));
    expect(await writeZliInstructions(dir, { browserTool: false })).not.toBe(path);
  });
});

describe("AgentSettingsStore", () => {
  it("starts empty, saves, and reads the saved settings back after a restart", async () => {
    const path = join(await tempDir(), "agent-settings.json");
    const store = new AgentSettingsStore(path);
    await store.load();
    expect(store.read()).toEqual({});
    expect(await store.save({ claudeAutoCompactTokens: 200_000 })).toEqual({ claudeAutoCompactTokens: 200_000 });
    const reopened = new AgentSettingsStore(path);
    await reopened.load();
    expect(reopened.read()).toEqual({ claudeAutoCompactTokens: 200_000 });
  });

  it("treats a broken file as defaults and refuses values Claude does not accept", async () => {
    const path = join(await tempDir(), "agent-settings.json");
    await writeFile(path, "{ not json", "utf8");
    const store = new AgentSettingsStore(path);
    await store.load();
    expect(store.read()).toEqual({});
    await expect(store.save({ claudeAutoCompactTokens: 5_000 })).rejects.toThrow();
    expect(store.read()).toEqual({});
  });
});
