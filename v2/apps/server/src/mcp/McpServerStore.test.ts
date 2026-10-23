import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpServerList } from "@zli-v2/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { McpServerStore, type McpUserSettingsSync } from "./McpServerStore.js";

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function storePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zli-mcp-"));
  temps.push(dir);
  return join(dir, "mcp-servers.json");
}

const github = { name: "github", enabled: true, command: "npx", args: ["-y", "gh-mcp"], env: { TOKEN: "t" } };
const linear = { name: "linear", enabled: false, command: "linear-mcp", args: [], env: {} };

describe("McpServerStore", () => {
  it("saves, reloads, and hands only enabled servers to agents", async () => {
    const path = await storePath();
    const store = new McpServerStore({ path });
    await store.load();
    expect(store.list()).toEqual({ servers: [], agentAccess: "full", userSettings: { enabled: false, outcomes: [] } });

    await store.save([github, linear]);
    const reloaded = new McpServerStore({ path });
    await reloaded.load();
    expect(reloaded.list().servers).toEqual([github, linear]);
    expect(reloaded.specs()).toEqual([{ name: "github", command: "npx", args: ["-y", "gh-mcp"], env: { TOKEN: "t" } }]);
  });

  it("keeps the agent tool access beside the servers", async () => {
    const path = await storePath();
    const store = new McpServerStore({ path });
    await store.load();
    await store.save([github]);
    expect((await store.setAgentAccess("read")).agentAccess).toBe("read");
    const reloaded = new McpServerStore({ path });
    await reloaded.load();
    expect(reloaded.agentAccess()).toBe("read");
    expect(reloaded.list().servers).toEqual([github]);
    await expect(store.setAgentAccess("everything" as never)).rejects.toThrow();
    expect(store.agentAccess()).toBe("read");
  });

  it("passes what ZLI owns to each sync and stores the new ownership", async () => {
    const path = await storePath();
    const calls: Array<{ names: string[]; owned: unknown }> = [];
    const sync: McpUserSettingsSync = async (specs, owned) => {
      calls.push({ names: specs.map((spec) => spec.name), owned });
      return {
        outcomes: [{ provider: "droid", path: "C:\\home\\.factory\\mcp.json", status: "updated" }],
        owned: specs.length > 0 ? { "C:\\home\\.factory\\mcp.json": specs.map((spec) => spec.name) } : {},
      };
    };
    const store = new McpServerStore({ path, syncUserSettings: sync });
    await store.load();
    const saved = await store.save([github]);
    expect(saved.userSettings).toEqual({
      enabled: true,
      outcomes: [{ provider: "droid", path: "C:\\home\\.factory\\mcp.json", status: "updated" }],
    });
    expect(JSON.parse(await readFile(path, "utf8")).owned).toEqual({ "C:\\home\\.factory\\mcp.json": ["github"] });

    const restarted = new McpServerStore({ path, syncUserSettings: sync });
    await restarted.load();
    await restarted.save([]);
    expect(calls).toEqual([
      { names: ["github"], owned: {} },
      { names: [], owned: { "C:\\home\\.factory\\mcp.json": ["github"] } },
    ]);
  });

  it("reports a damaged file instead of throwing, and saving replaces it", async () => {
    const path = await storePath();
    await writeFile(path, "{ nope", "utf8");
    const store = new McpServerStore({ path });
    await store.load();
    expect(store.list().problem).toBe("The saved MCP server list is not valid JSON.");
    expect(store.specs()).toEqual([]);
    expect((await store.save([github])).problem).toBeUndefined();
  });

  it("rejects duplicate and reserved names", () => {
    expect(McpServerList.safeParse([github, { ...github, name: "GitHub" }]).success).toBe(false);
    expect(McpServerList.safeParse([{ ...github, name: "zli-browser" }]).success).toBe(false);
    expect(McpServerList.safeParse([{ ...github, name: "has space" }]).success).toBe(false);
    expect(McpServerList.safeParse([{ ...github, env: { "BAD-NAME": "x" } }]).success).toBe(false);
  });
});
