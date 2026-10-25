import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { McpServerList } from "@zli-v2/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { McpProbe } from "./McpProbe.js";
import {
  McpRequestError,
  McpServerStore,
  type McpUserSettingsSync,
  mcpLaunchSpec,
  projectPathKey,
  serverInProject,
} from "./McpServerStore.js";
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
      health: [],
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

  it("hands remote servers with headers or sign-in to agents through the connect bridge with private files", async () => {
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
    const plain = { ...context7, name: "plain", headers: {} };
    expect(mcpLaunchSpec(plain, { connectTool })).toEqual({
      transport: "http",
      name: "plain",
      url: context7.url,
      headers: {},
    });
    expect(reloaded.specs()).toEqual([
      {
        name: "context7",
        command: "/apps/ZLI",
        args: [
          "/apps/zli-connect.js",
          "mcp",
          "--name",
          "context7",
          "--url",
          context7.url,
          "--header-file",
          reloaded.headerFile("context7"),
        ],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      },
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
    expect(await readFile(reloaded.headerFile("context7"), "utf8")).toBe("Authorization: Bearer ctx\n");
    if (process.platform !== "win32") expect((await stat(headerFile)).mode & 0o777).toBe(0o600);

    await reloaded.save([
      { ...context7, headers: {} },
      { ...sentry, headers: {} },
    ]);
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

describe("McpServerStore launch rules", () => {
  const connectTool = { command: "/apps/ZLI", script: "/apps/zli-connect.js" };

  it("keeps the new fields out of saved servers that do not use them", async () => {
    const path = await storePath();
    const store = new McpServerStore({ path });
    await store.load();
    await store.save([github]);
    expect(JSON.parse(await readFile(path, "utf8")).servers).toEqual([github]);
  });

  it("runs local servers with turned-off tools through the bridge, from private files", async () => {
    const path = await storePath();
    const store = new McpServerStore({ path, connectTool });
    await store.load();
    const quiet = { ...github, disabledTools: ["delete_repo"] };
    await store.save([quiet]);
    const specFile = store.specFile("github");
    const toolsFile = store.hideToolsFile("github");
    expect(store.specs()).toEqual([
      {
        name: "github",
        command: "/apps/ZLI",
        args: ["/apps/zli-connect.js", "stdio", "--name", "github", "--spec-file", specFile, "--hide-tools", toolsFile],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      },
    ]);
    expect(JSON.parse(await readFile(specFile, "utf8"))).toEqual({
      command: "npx",
      args: ["-y", "gh-mcp"],
      env: { TOKEN: "t" },
    });
    expect(JSON.parse(await readFile(toolsFile, "utf8"))).toEqual(["delete_repo"]);
    if (process.platform !== "win32") {
      expect((await stat(specFile)).mode & 0o777).toBe(0o600);
      expect((await stat(toolsFile)).mode & 0o777).toBe(0o600);
    }
    expect(store.list().servers).toEqual([quiet]);

    // Without the bridge the server still starts; the tools just stay visible.
    expect(mcpLaunchSpec(quiet)).toEqual({
      name: "github",
      command: "npx",
      args: ["-y", "gh-mcp"],
      env: { TOKEN: "t" },
    });

    await store.save([github]);
    expect(await readdir(dirname(specFile))).toEqual([]);
  });

  it("hides tools of remote servers in the bridge too", () => {
    const remote = {
      name: "linear",
      enabled: true,
      transport: "http" as const,
      url: "https://mcp.linear.app/mcp",
      headers: {},
      oauth: false,
      disabledTools: ["delete"],
    };
    expect(mcpLaunchSpec(remote, { connectTool, hideToolsFile: "/d/linear.hidden-tools.json" })).toEqual({
      name: "linear",
      command: "/apps/ZLI",
      args: [
        "/apps/zli-connect.js",
        "mcp",
        "--name",
        "linear",
        "--url",
        remote.url,
        "--hide-tools",
        "/d/linear.hidden-tools.json",
      ],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    // A remote server with nothing to hide, no headers, and no sign-in goes to agents as a plain URL.
    expect(mcpLaunchSpec({ ...remote, disabledTools: [] }, { connectTool })).toEqual({
      transport: "http",
      name: "linear",
      url: remote.url,
      headers: {},
    });
  });

  it("gives servers limited to projects only to agents in those projects, and never to user settings", async () => {
    const path = await storePath();
    const synced: string[][] = [];
    const store = new McpServerStore({
      path,
      syncUserSettings: async (specs) => {
        synced.push(specs.map((spec) => spec.name));
        return { outcomes: [], owned: {} };
      },
      extraServers: () => [{ ...linear, name: "plugin", enabled: true, projects: ["/elsewhere"] }],
    });
    await store.load();
    const scoped = { ...github, projects: ["/work/app", "C:\\Work\\Site"] };
    await store.save([scoped]);
    const names = (projectPath?: string) => store.specs(projectPath ? { projectPath } : {}).map((spec) => spec.name);
    expect(names()).toEqual(["plugin"]);
    expect(names("/work/app/")).toEqual(["github", "plugin"]);
    expect(names("/work/other")).toEqual(["plugin"]);
    expect(synced).toEqual([["plugin"]]);
  });

  it("matches project paths the way the system does", () => {
    const scoped = { ...github, projects: ["C:\\Work\\Site\\", "/srv/app"] };
    expect(serverInProject(scoped, "c:/work/site", "win32")).toBe(true);
    expect(serverInProject(scoped, "/srv/app/", "linux")).toBe(true);
    expect(serverInProject(scoped, "/SRV/app", "linux")).toBe(false);
    expect(serverInProject(github, undefined, "linux")).toBe(true);
    expect(serverInProject({ ...github, projects: [] }, undefined, "linux")).toBe(true);
    expect(projectPathKey("C:\\", "win32")).toBe("c:\\");
  });

  it("checks project paths and turned-off tool names", () => {
    expect(McpServerList.safeParse([{ ...github, projects: ["relative/path"] }]).success).toBe(false);
    expect(McpServerList.safeParse([{ ...github, projects: ["D:\\code"] }]).success).toBe(true);
    expect(McpServerList.safeParse([{ ...github, disabledTools: [""] }]).success).toBe(false);
    expect(
      McpServerList.safeParse([{ ...github, disabledTools: Array.from({ length: 201 }, (_, i) => `t${i}`) }]).success,
    ).toBe(false);
  });
});

describe("McpServerStore connection tests", () => {
  it("tests the person's and plugins' servers, keeps the results, and forgets them when settings change", async () => {
    const path = await storePath();
    const probed: string[] = [];
    const probe: McpProbe = async (server) => {
      probed.push(server.name);
      return server.name === "github"
        ? { ok: true, tools: [{ name: "search" }, { name: "delete_repo", description: "Deletes a repo" }] }
        : {
            ok: false,
            tools: [],
            problem: "ZLI could not start docs-mcp. Check that docs-mcp is installed and on your PATH, then try again.",
          };
    };
    const store = new McpServerStore({
      path,
      probe,
      now: () => Date.parse("2025-03-01T10:00:00.000Z"),
      extraServers: () => [{ name: "docs", enabled: true, command: "docs-mcp", args: [], env: {} }],
    });
    await store.load();
    await store.save([{ ...github, disabledTools: ["delete_repo"] }]);

    expect(await store.test("GitHub")).toEqual({
      name: "github",
      ok: true,
      tools: [{ name: "search" }, { name: "delete_repo", description: "Deletes a repo" }],
      testedAt: "2025-03-01T10:00:00.000Z",
    });
    expect((await store.test("docs")).ok).toBe(false);
    expect(probed).toEqual(["github", "docs"]);
    expect(store.list().health).toEqual([
      { name: "github", ok: true, toolCount: 2, testedAt: "2025-03-01T10:00:00.000Z" },
      {
        name: "docs",
        ok: false,
        toolCount: 0,
        problem: "ZLI could not start docs-mcp. Check that docs-mcp is installed and on your PATH, then try again.",
        testedAt: "2025-03-01T10:00:00.000Z",
      },
    ]);

    await store.save([{ ...github, disabledTools: ["delete_repo"] }]);
    expect(store.list().health.map((entry) => entry.name)).toEqual(["github", "docs"]);
    await store.save([{ ...github, enabled: false, projects: ["/work/app"] }]);
    expect(store.list().health.map((entry) => entry.name)).toEqual(["github", "docs"]);
    await store.save([{ ...github, env: { TOKEN: "other" } }]);
    expect(store.list().health.map((entry) => entry.name)).toEqual(["docs"]);
    await expect(store.test("nope")).rejects.toThrow(McpRequestError);
  });

  it("hands sign-in servers the saved login and reports when it is needed", async () => {
    const path = await storePath();
    const signIns = new McpSignIns({ dir: join(dirname(path), "mcp-sign-in") });
    let token: string | undefined = "not called";
    const store = new McpServerStore({
      path,
      signIns,
      probe: async (_server, options) => {
        token = await options?.getToken?.(false);
        return { ok: false, tools: [], needsSignIn: true, problem: "Sign in to sentry first." };
      },
    });
    await store.load();
    await store.save([
      { name: "sentry", enabled: true, transport: "http", url: "https://mcp.sentry.dev/mcp", headers: {}, oauth: true },
    ]);
    const result = await store.test("sentry");
    expect(token).toBeUndefined();
    expect(result).toMatchObject({ ok: false, needsSignIn: true, problem: "Sign in to sentry first." });
    expect(store.list().health[0]).toMatchObject({ name: "sentry", needsSignIn: true, toolCount: 0 });
  });
});

describe("McpServerStore import", () => {
  it("offers servers from other apps and marks the ones ZLI already has", async () => {
    const path = await storePath();
    const home = dirname(path);
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { github: { command: "npx", args: [] }, fetch: { command: "uvx", args: ["mcp-server-fetch"] } },
      }),
      "utf8",
    );
    const store = new McpServerStore({ path, importFrom: { home, platform: "linux", env: {} } });
    await store.load();
    await store.save([github]);
    const result = await store.scanImports();
    expect(result.problems).toEqual([]);
    expect(result.found.map((entry) => [entry.server.name, entry.exists])).toEqual([
      ["github", true],
      ["fetch", false],
    ]);
  });
});
