import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  accountSettingsFile,
  PROJECT_MCP_FILES,
  projectMcpFile,
  projectMcpFileContents,
  removeZliFromUserSettings,
  syncAccountMcpServers,
} from "./mcpSettingsFiles.js";

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zli-home-"));
  temps.push(dir);
  return dir;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

const stdio = {
  name: "zli",
  command: "C:\\ZLI\\ZLI.exe",
  args: ["zli-agent.js", "mcp"],
  env: { ZLI_WORKTREE_ID: "wt" },
};
const remote = {
  transport: "http" as const,
  name: "linear",
  url: "https://mcp.linear.app/mcp",
  headers: { Authorization: "Bearer t" },
};

describe("project MCP files", () => {
  it("names the file each CLI reads in the folder it starts in", () => {
    expect(PROJECT_MCP_FILES).toEqual({
      "cursor-agent": ".cursor/mcp.json",
      droid: ".factory/mcp.json",
      kimi: ".kimi-code/mcp.json",
      gemini: ".gemini/settings.json",
      qwen: ".qwen/settings.json",
    });
    expect(projectMcpFile("droid")).toBe(".factory/mcp.json");
    expect(projectMcpFile("claude-code")).toBeUndefined();
    expect(projectMcpFile("codex")).toBeUndefined();
  });

  it("writes every server in each CLI's own format", () => {
    const local = { command: stdio.command, args: stdio.args, env: stdio.env };
    const headers = { Authorization: "Bearer t" };
    expect(JSON.parse(projectMcpFileContents("droid", [stdio, remote]))).toEqual({
      mcpServers: { zli: { type: "stdio", ...local }, linear: { type: "http", url: remote.url, headers } },
    });
    for (const provider of ["cursor-agent", "kimi"] as const) {
      expect(JSON.parse(projectMcpFileContents(provider, [stdio, remote]))).toEqual({
        mcpServers: { zli: local, linear: { url: remote.url, headers } },
      });
    }
    for (const provider of ["gemini", "qwen"] as const) {
      expect(JSON.parse(projectMcpFileContents(provider, [stdio, { ...remote, headers: {} }]))).toEqual({
        mcpServers: { zli: local, linear: { httpUrl: remote.url } },
      });
    }
    expect(projectMcpFileContents("droid", [])).toBe('{\n  "mcpServers": {}\n}\n');
  });
});

describe("removeZliFromUserSettings", () => {
  it("removes ZLI's built-in servers and the ones it copied, and keeps everything else", async () => {
    const dir = await home();
    const factory = join(dir, ".factory", "mcp.json");
    const gemini = join(dir, ".gemini", "settings.json");
    await mkdir(join(dir, ".factory"));
    await mkdir(join(dir, ".gemini"));
    await writeFile(
      factory,
      JSON.stringify({
        mcpServers: {
          zli: { type: "stdio", command: "zli" },
          "zli-browser": { type: "stdio", command: "zli" },
          "zli-mobile": { type: "stdio", command: "zli" },
          github: { type: "stdio", command: "npx" },
          mine: { type: "http", url: "https://example.com/mcp" },
        },
      }),
      "utf8",
    );
    const original = {
      theme: "Dracula",
      security: { auth: { selectedType: "oauth-personal" } },
      mcpServers: { "zli-browser": { command: "zli" }, github: { command: "npx" } },
    };
    await writeFile(gemini, `${JSON.stringify(original, null, "\t")}\n`, "utf8");

    const remaining = await removeZliFromUserSettings({ [factory]: ["github"] }, { home: dir, env: {} });
    expect(remaining).toEqual({});
    expect(await readJson(factory)).toEqual({ mcpServers: { mine: { type: "http", url: "https://example.com/mcp" } } });
    // github was not recorded as ZLI's in this file, so it stays.
    const written = await readFile(gemini, "utf8");
    expect(JSON.parse(written)).toEqual({ ...original, mcpServers: { github: { command: "npx" } } });
    expect(written.split("\n")[1]?.startsWith('\t"theme"')).toBe(true);
  });

  it("creates nothing, honors KIMI_CODE_HOME, and cleans files recorded at older paths", async () => {
    const dir = await home();
    const kimiHome = join(dir, "kimi-home");
    const old = join(dir, "old-kimi", "mcp.json");
    await mkdir(kimiHome);
    await mkdir(join(dir, "old-kimi"));
    await writeFile(join(kimiHome, "mcp.json"), JSON.stringify({ mcpServers: { zli: {}, other: {} } }), "utf8");
    await writeFile(old, JSON.stringify({ mcpServers: { linear: {}, other: {} } }), "utf8");
    expect(
      await removeZliFromUserSettings({ [old]: ["linear"] }, { home: dir, env: { KIMI_CODE_HOME: kimiHome } }),
    ).toEqual({});
    expect(await readJson(join(kimiHome, "mcp.json"))).toEqual({ mcpServers: { other: {} } });
    expect(await readJson(old)).toEqual({ mcpServers: { other: {} } });
    expect((await readdir(dir)).sort()).toEqual(["kimi-home", "old-kimi"]);
    await expect(stat(join(dir, ".factory"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves files it cannot parse exactly as they were and keeps their record for a later try", async () => {
    const dir = await home();
    await mkdir(join(dir, ".cursor"));
    await mkdir(join(dir, ".qwen"));
    const cursor = join(dir, ".cursor", "mcp.json");
    const qwen = join(dir, ".qwen", "settings.json");
    const jsonc = '{\n  // my servers\n  "mcpServers": { "zli": {} }\n}\n';
    await writeFile(cursor, jsonc, "utf8");
    await writeFile(qwen, JSON.stringify({ mcpServers: [] }), "utf8");
    // A directory where the settings file should be makes the read fail with EISDIR.
    await mkdir(join(dir, ".factory", "mcp.json"), { recursive: true });
    const logs: Array<{ level: string; path: unknown }> = [];
    const remaining = await removeZliFromUserSettings(
      { [cursor]: ["github"], [join(dir, ".factory", "mcp.json")]: ["linear"] },
      { home: dir, env: {}, log: (level, _message, context) => logs.push({ level, path: context.path }) },
    );
    expect(remaining).toEqual({ [cursor]: ["github"], [join(dir, ".factory", "mcp.json")]: ["linear"] });
    expect(await readFile(cursor, "utf8")).toBe(jsonc);
    expect(logs).toEqual([
      { level: "warn", path: cursor },
      { level: "warn", path: join(dir, ".factory", "mcp.json") },
      { level: "warn", path: qwen },
    ]);
  });

  it("accepts a UTF-8 BOM", async () => {
    const dir = await home();
    await mkdir(join(dir, ".cursor"));
    await writeFile(join(dir, ".cursor", "mcp.json"), `\uFEFF${JSON.stringify({ mcpServers: { zli: {} } })}`, "utf8");
    await removeZliFromUserSettings({}, { home: dir, env: {} });
    expect(await readJson(join(dir, ".cursor", "mcp.json"))).toEqual({ mcpServers: {} });
  });
});

describe("syncAccountMcpServers", () => {
  const github = { name: "github", command: "npx", args: ["-y", "gh-mcp"], env: {} };

  it("writes servers into the settings file inside an account's own config folder", async () => {
    const dir = await home();
    expect(accountSettingsFile("cursor-agent", dir)).toBe(join(dir, "mcp.json"));
    expect(accountSettingsFile("gemini", dir)).toBe(join(dir, ".gemini", "settings.json"));
    expect(accountSettingsFile("qwen", dir)).toBe(join(dir, "settings.json"));
    expect(accountSettingsFile("codex", dir)).toBeUndefined();

    const owned = await syncAccountMcpServers("kimi", dir, [github], []);
    expect(owned).toEqual(["github"]);
    expect(await readJson(join(dir, "mcp.json"))).toMatchObject({ mcpServers: { github: { command: "npx" } } });

    expect(await syncAccountMcpServers("kimi", dir, [], owned ?? [])).toEqual([]);
    expect(await readJson(join(dir, "mcp.json"))).toEqual({ mcpServers: {} });
    await expect(syncAccountMcpServers("codex", dir, [github], [])).resolves.toBeUndefined();
  });

  it("refreshes moved paths but keeps fields the person added to the entry", async () => {
    const dir = await home();
    const path = join(dir, "mcp.json");
    await writeFile(
      path,
      JSON.stringify({ mcpServers: { github: { command: "old", args: [], env: {}, disabled: true }, mine: {} } }),
      "utf8",
    );
    expect(await syncAccountMcpServers("cursor-agent", dir, [github], ["github"])).toEqual(["github"]);
    expect(await readJson(path)).toEqual({
      mcpServers: { github: { command: "npx", args: ["-y", "gh-mcp"], env: {}, disabled: true }, mine: {} },
    });
  });
});
