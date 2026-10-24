import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { McpServerList } from "@zli-v2/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { McpServerStore, type McpUserSettingsSync, mcpLaunchSpec } from "./McpServerStore.js";
import { McpSignIns } from "./signIn/McpSignIns.js";

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
    expect(store.list()).toEqual({
      servers: [],
      agentAccess: "full",
      userSettings: { enabled: false, outcomes: [] },
      signIns: [],
    });

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

  it("hands remote servers to agents as URLs, and sign-in ones through the connect bridge with private files", async () => {
    const path = await storePath();
    const signIns = new McpSignIns({ dir: join(dirname(path), "mcp-sign-in") });
    const connectTool = { command: "/apps/ZLI", script: "/apps/zli-connect.js" };
    const store = new McpServerStore({ path, signIns, connectTool });
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

    const reloaded = new McpServerStore({ path, signIns, connectTool });
    await reloaded.load();
    expect(reloaded.list().servers).toEqual([context7, sentry]);
    expect(reloaded.list().signIns).toEqual([{ name: "sentry", url: sentry.url, signedIn: false }]);
    const headerFile = reloaded.headerFile("sentry");
    expect(reloaded.specs()).toEqual([
      { transport: "http", name: "context7", url: context7.url, headers: { Authorization: "Bearer ctx" } },
      {
        name: "sentry",
        command: "/apps/ZLI",
        args: [
          "/apps/zli-connect.js",
          "mcp",
          "--name",
          "sentry",
          "--url",
          sentry.url,
          "--token-file",
          signIns.tokenFile(sentry.url),
          "--header-file",
          headerFile,
        ],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      },
    ]);
    expect(await readFile(headerFile, "utf8")).toBe("X-Org: acme\n");
    if (process.platform !== "win32") expect((await stat(headerFile)).mode & 0o777).toBe(0o600);

    await reloaded.save([context7, { ...sentry, headers: {} }]);
    expect(await readdir(dirname(headerFile))).toEqual([]);
  });

  it("without the bridge, gives sign-in servers the saved token as a header", () => {
    const server = {
      name: "local",
      enabled: true,
      transport: "http" as const,
      url: "http://localhost:3000/mcp",
      headers: { authorization: "Bearer old", "X-Team": "a" },
      oauth: true,
    };
    expect(mcpLaunchSpec(server, { accessToken: "fresh" })).toEqual({
      transport: "http",
      name: "local",
      url: server.url,
      headers: { "X-Team": "a", Authorization: "Bearer fresh" },
    });
    expect(mcpLaunchSpec({ ...server, headers: {} })).toEqual({
      transport: "http",
      name: "local",
      url: server.url,
      headers: {},
    });
    // Headers stay out of the process list, so the bridge is skipped without a header file.
    expect(mcpLaunchSpec(server, { connectTool: { command: "/z", script: "/c.js" } })).toMatchObject({
      transport: "http",
    });
  });

  it("refuses sign-in for servers that do not use it", async () => {
    const path = await storePath();
    const store = new McpServerStore({ path, signIns: new McpSignIns({ dir: join(dirname(path), "s") }) });
    await store.load();
    await store.save([github]);
    await expect(store.signIn("github")).rejects.toThrow("github does not use sign-in.");
    await expect(store.signIn("nope")).rejects.toThrow("There is no MCP server named nope.");
    await expect(new McpServerStore({ path }).signOut("github")).rejects.toThrow("Signing in is not available here.");
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
