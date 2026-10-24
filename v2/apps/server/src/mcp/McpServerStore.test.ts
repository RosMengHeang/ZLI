import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { MCP_REMOTE_PACKAGE, McpServerList } from "@zli-v2/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { McpServerStore, type McpUserSettingsSync, mcpLaunchSpec } from "./McpServerStore.js";

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

  it("loads lists saved before remote servers existed as local commands", async () => {
    const path = await storePath();
    await writeFile(path, JSON.stringify({ version: 1, servers: [github], owned: {}, agentAccess: "read" }), "utf8");
    const store = new McpServerStore({ path });
    await store.load();
    expect(store.list().problem).toBeUndefined();
    expect(store.list().servers).toEqual([github]);
    expect(store.specs()).toEqual([{ name: "github", command: "npx", args: ["-y", "gh-mcp"], env: { TOKEN: "t" } }]);
  });

  it("hands remote servers to agents as URLs, and sign-in ones through mcp-remote with a private header file", async () => {
    const path = await storePath();
    const store = new McpServerStore({ path });
    await store.load();
    const context7 = {
      name: "context7",
      enabled: true,
      transport: "http" as const,
      url: "https://mcp.context7.com/mcp",
      headers: { Authorization: "Bearer ctx" },
      oauth: false,
    };
    const sentry = {
      ...context7,
      name: "sentry",
      url: "https://mcp.sentry.dev/mcp",
      headers: { "X-Org": "acme" },
      oauth: true,
    };
    await store.save([context7, sentry]);

    const reloaded = new McpServerStore({ path });
    await reloaded.load();
    expect(reloaded.list().servers).toEqual([context7, sentry]);
    const headerFile = reloaded.headerFile("sentry");
    expect(reloaded.specs()).toEqual([
      { transport: "http", name: "context7", url: context7.url, headers: { Authorization: "Bearer ctx" } },
      {
        name: "sentry",
        command: process.platform === "win32" ? "cmd" : "npx",
        args: [
          ...(process.platform === "win32" ? ["/c", "npx"] : []),
          "-y",
          MCP_REMOTE_PACKAGE,
          sentry.url,
          "--header-file",
          headerFile,
        ],
        env: {},
      },
    ]);
    expect(await readFile(headerFile, "utf8")).toBe("X-Org: acme\n");
    if (process.platform !== "win32") expect((await stat(headerFile)).mode & 0o777).toBe(0o600);

    await reloaded.save([context7, { ...sentry, headers: {} }]);
    expect(await readdir(dirname(headerFile))).toEqual([]);
  });

  it("builds the mcp-remote bridge for each platform", () => {
    const server = {
      name: "local",
      enabled: true,
      transport: "http" as const,
      url: "http://localhost:3000/mcp",
      headers: { Authorization: "Bearer t" },
      oauth: true,
    };
    expect(mcpLaunchSpec(server, { platform: "win32" })).toEqual({
      name: "local",
      command: "cmd",
      args: ["/c", "npx", "-y", MCP_REMOTE_PACKAGE, server.url, "--allow-http", "--header", "Authorization:Bearer t"],
      env: {},
    });
    expect(mcpLaunchSpec({ ...server, headers: {} }, { platform: "darwin", headerFile: "/x.headers" })).toEqual({
      name: "local",
      command: "npx",
      args: ["-y", MCP_REMOTE_PACKAGE, server.url, "--allow-http"],
      env: {},
    });
  });
  it("rejects duplicate and reserved names", () => {
    expect(McpServerList.safeParse([github, { ...github, name: "GitHub" }]).success).toBe(false);
    expect(McpServerList.safeParse([{ ...github, name: "zli-browser" }]).success).toBe(false);
    expect(McpServerList.safeParse([{ ...github, name: "has space" }]).success).toBe(false);
    expect(McpServerList.safeParse([{ ...github, env: { "BAD-NAME": "x" } }]).success).toBe(false);
  });

  it("accepts https addresses, and http only on this computer", () => {
    const remote = { name: "r", enabled: true, transport: "http", headers: {}, oauth: false };
    const ok = (url: string) => McpServerList.safeParse([{ ...remote, url }]).success;
    expect(ok("https://mcp.linear.app/mcp")).toBe(true);
    expect(ok("http://localhost:3000/mcp")).toBe(true);
    expect(ok("http://127.0.0.1:3845/mcp")).toBe(true);
    expect(ok("http://[::1]:8080/mcp")).toBe(true);
    expect(ok("http://mcp.example.com/mcp")).toBe(false);
    expect(ok("ftp://mcp.example.com")).toBe(false);
    expect(ok("https://user:pass@mcp.example.com")).toBe(false);
    expect(ok("https://mcp.example.com/a b")).toBe(false);
    expect(McpServerList.safeParse([{ ...remote, url: "https://x.dev", headers: { "Bad Name": "v" } }]).success).toBe(
      false,
    );
    expect(McpServerList.safeParse([{ ...remote, url: "https://x.dev", headers: { A: "line\nbreak" } }]).success).toBe(
      false,
    );
  });
});
