import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { BrowserToolConfig } from "./browserTool.js";
import { registerBrowserToolInUserSettings, syncUserMcpServers, type UserSettingsProvider } from "./userSettings.js";

const config: BrowserToolConfig = {
  command: "C:\\ZLI\\ZLI.exe",
  script: "C:\\ZLI\\resources\\zli-browser.js",
  controlFile: "C:\\Users\\dev\\AppData\\Roaming\\ZLI\\browser-control.json",
  shimDir: "C:\\Users\\dev\\AppData\\Roaming\\ZLI\\bin",
  mcpConfigDir: "C:\\Users\\dev\\AppData\\Roaming\\ZLI\\mcp",
};
const stdio = {
  command: config.command,
  args: [config.script, "mcp"],
  env: { ELECTRON_RUN_AS_NODE: "1", ZLI_BROWSER_CONTROL_FILE: config.controlFile },
};

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zli-home-"));
  temps.push(dir);
  return dir;
}

const installed =
  (...providers: UserSettingsProvider[]) =>
  async (provider: UserSettingsProvider) =>
    providers.includes(provider);

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

describe("registerBrowserToolInUserSettings", () => {
  it("creates settings for installed CLIs and skips CLIs that are absent with no config dir", async () => {
    const dir = await home();
    const outcomes = await registerBrowserToolInUserSettings(config, {
      home: dir,
      env: {},
      isInstalled: installed("cursor-agent", "droid", "kimi"),
    });
    expect(outcomes.map((outcome) => [outcome.provider, outcome.status])).toEqual([
      ["cursor-agent", "created"],
      ["droid", "created"],
      ["kimi", "created"],
      ["gemini", "skipped-absent"],
      ["qwen", "skipped-absent"],
    ]);
    expect(await readJson(join(dir, ".cursor", "mcp.json"))).toEqual({ mcpServers: { "zli-browser": stdio } });
    expect(await readJson(join(dir, ".factory", "mcp.json"))).toEqual({
      mcpServers: { "zli-browser": { type: "stdio", ...stdio } },
    });
    expect(await readJson(join(dir, ".kimi-code", "mcp.json"))).toEqual({ mcpServers: { "zli-browser": stdio } });
    await expect(stat(join(dir, ".gemini"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes for a CLI that is not on PATH when its config dir already exists, and honors KIMI_CODE_HOME", async () => {
    const dir = await home();
    await mkdir(join(dir, ".gemini"));
    const kimiHome = join(dir, "kimi-home");
    const outcomes = await registerBrowserToolInUserSettings(config, {
      home: dir,
      env: { KIMI_CODE_HOME: kimiHome },
      isInstalled: installed("kimi"),
    });
    expect(outcomes.find((outcome) => outcome.provider === "gemini")?.status).toBe("created");
    expect(await readJson(join(dir, ".gemini", "settings.json"))).toEqual({ mcpServers: { "zli-browser": stdio } });
    expect(outcomes.find((outcome) => outcome.provider === "kimi")?.path).toBe(join(kimiHome, "mcp.json"));
  });

  it("keeps every other key and server, the file's indentation, and is idempotent", async () => {
    const dir = await home();
    const path = join(dir, ".gemini", "settings.json");
    await mkdir(join(dir, ".gemini"));
    const original = {
      theme: "Dracula",
      security: { auth: { selectedType: "oauth-personal" } },
      mcpServers: { github: { command: "npx", args: ["-y", "gh-mcp"], env: { TOKEN: "$GH" } } },
    };
    await writeFile(path, `${JSON.stringify(original, null, "\t")}\n`, "utf8");
    const options = { home: dir, env: {}, isInstalled: installed() };

    expect((await registerBrowserToolInUserSettings(config, options))[3]?.status).toBe("created");
    const written = await readFile(path, "utf8");
    expect(JSON.parse(written)).toEqual({
      ...original,
      mcpServers: { ...original.mcpServers, "zli-browser": stdio },
    });
    expect(written.split("\n")[1]?.startsWith('\t"theme"')).toBe(true);

    const before = (await stat(path)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await registerBrowserToolInUserSettings(config, options))[3]?.status).toBe("unchanged");
    expect((await stat(path)).mtimeMs).toBe(before);
    expect(await readdir(join(dir, ".gemini"))).toEqual(["settings.json"]);
  });

  it("refreshes moved paths but keeps fields the user added to the entry", async () => {
    const dir = await home();
    const path = join(dir, ".factory", "mcp.json");
    await mkdir(join(dir, ".factory"));
    await writeFile(
      path,
      JSON.stringify({
        mcpServers: {
          linear: { type: "http", url: "https://mcp.linear.app/mcp" },
          "zli-browser": { type: "stdio", command: "D:\\old\\electron.exe", args: ["old.js", "mcp"], disabled: true },
        },
      }),
      "utf8",
    );
    const outcomes = await registerBrowserToolInUserSettings(config, {
      home: dir,
      env: {},
      isInstalled: installed("droid"),
    });
    expect(outcomes.find((outcome) => outcome.provider === "droid")?.status).toBe("updated");
    expect(await readJson(path)).toEqual({
      mcpServers: {
        linear: { type: "http", url: "https://mcp.linear.app/mcp" },
        "zli-browser": { type: "stdio", ...stdio, disabled: true },
      },
    });
  });

  it("leaves files it cannot parse exactly as they were and logs once per file", async () => {
    const dir = await home();
    await mkdir(join(dir, ".cursor"));
    await mkdir(join(dir, ".qwen"));
    const jsonc = '{\n  // my servers\n  "mcpServers": {}\n}\n';
    await writeFile(join(dir, ".cursor", "mcp.json"), jsonc, "utf8");
    await writeFile(join(dir, ".qwen", "settings.json"), JSON.stringify({ mcpServers: [] }), "utf8");
    const logs: Array<{ level: string; context: Record<string, unknown> }> = [];
    const outcomes = await registerBrowserToolInUserSettings(config, {
      home: dir,
      env: {},
      isInstalled: installed("cursor-agent"),
      log: (level, _message, context) => logs.push({ level, context }),
    });
    expect(outcomes.find((outcome) => outcome.provider === "cursor-agent")?.status).toBe("skipped-invalid");
    expect(outcomes.find((outcome) => outcome.provider === "qwen")?.status).toBe("skipped-invalid");
    expect(await readFile(join(dir, ".cursor", "mcp.json"), "utf8")).toBe(jsonc);
    expect(logs.filter((entry) => entry.level === "warn").map((entry) => entry.context.provider)).toEqual([
      "cursor-agent",
      "qwen",
    ]);
  });

  it("accepts a UTF-8 BOM and never throws when discovery or the file system fails", async () => {
    const dir = await home();
    await mkdir(join(dir, ".cursor"));
    await writeFile(join(dir, ".cursor", "mcp.json"), `\uFEFF${JSON.stringify({ mcpServers: {} })}`, "utf8");
    // A directory where the settings file should be makes the read fail with EISDIR.
    await mkdir(join(dir, ".factory", "mcp.json"), { recursive: true });
    const outcomes = await registerBrowserToolInUserSettings(config, {
      home: dir,
      env: {},
      isInstalled: async (provider) => {
        if (provider === "kimi") throw new Error("discovery failed");
        return provider === "droid";
      },
    });
    expect(outcomes.map((outcome) => [outcome.provider, outcome.status])).toEqual([
      ["cursor-agent", "created"],
      ["droid", "failed"],
      ["kimi", "skipped-absent"],
      ["gemini", "skipped-absent"],
      ["qwen", "skipped-absent"],
    ]);
  });
});
describe("syncUserMcpServers", () => {
  const github = { name: "github", command: "npx", args: ["-y", "gh-mcp"], env: { TOKEN: "t" } };
  const linear = { name: "linear", command: "linear-mcp", args: [], env: {} };

  it("adds every server, then removes only the ones ZLI added", async () => {
    const dir = await home();
    const path = join(dir, ".cursor", "mcp.json");
    await mkdir(join(dir, ".cursor"));
    const mine = { command: "my-linear", args: [] };
    await writeFile(path, JSON.stringify({ mcpServers: { linear: mine } }), "utf8");
    const options = { home: dir, env: {}, isInstalled: installed("cursor-agent") };

    const first = await syncUserMcpServers([github, linear], {}, options);
    expect(first.outcomes.find((outcome) => outcome.provider === "cursor-agent")?.status).toBe("updated");
    expect(first.owned).toEqual({ [path]: ["github"] });
    expect(await readJson(path)).toEqual({
      mcpServers: {
        linear: { command: "linear-mcp", args: [], env: {} },
        github: { command: "npx", args: ["-y", "gh-mcp"], env: { TOKEN: "t" } },
      },
    });

    const second = await syncUserMcpServers([], first.owned, options);
    expect(second.owned).toEqual({});
    // The person's own linear entry stays, with the fields ZLI last wrote.
    expect(await readJson(path)).toEqual({ mcpServers: { linear: { command: "linear-mcp", args: [], env: {} } } });
  });

  it("writes Droid's stdio type, touches nothing when there is nothing to do, and keeps ownership after a failure", async () => {
    const dir = await home();
    const droid = join(dir, ".factory", "mcp.json");
    const options = { home: dir, env: {}, isInstalled: installed("droid") };
    const added = await syncUserMcpServers([github], {}, options);
    expect(await readJson(droid)).toEqual({
      mcpServers: { github: { type: "stdio", command: "npx", args: ["-y", "gh-mcp"], env: { TOKEN: "t" } } },
    });
    expect(added.owned).toEqual({ [droid]: ["github"] });

    const empty = await home();
    const idle = await syncUserMcpServers([], {}, { home: empty, env: {}, isInstalled: installed("droid") });
    expect(idle.outcomes.every((outcome) => outcome.status === "unchanged")).toBe(true);
    await expect(stat(join(empty, ".factory"))).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(droid, "{ broken", "utf8");
    const failed = await syncUserMcpServers([], added.owned, options);
    expect(failed.outcomes.find((outcome) => outcome.provider === "droid")?.status).toBe("skipped-invalid");
    expect(failed.owned).toEqual(added.owned);
  });
  it("writes remote servers in each agent's own format and drops the old transport's keys", async () => {
    const dir = await home();
    const options = {
      home: dir,
      env: {},
      isInstalled: installed("cursor-agent", "droid", "kimi", "gemini", "qwen"),
    };
    const cursor = join(dir, ".cursor", "mcp.json");
    await mkdir(join(dir, ".cursor"));
    await writeFile(
      cursor,
      JSON.stringify({ mcpServers: { linear: { command: "old", args: [], env: {}, disabled: true } } }),
      "utf8",
    );
    const remote = {
      transport: "http" as const,
      name: "linear",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer t" },
    };
    await syncUserMcpServers([remote], {}, options);
    const headers = { Authorization: "Bearer t" };
    expect(await readJson(cursor)).toEqual({
      mcpServers: { linear: { url: remote.url, headers, disabled: true } },
    });
    expect(await readJson(join(dir, ".factory", "mcp.json"))).toEqual({
      mcpServers: { linear: { type: "http", url: remote.url, headers } },
    });
    expect(await readJson(join(dir, ".kimi-code", "mcp.json"))).toEqual({
      mcpServers: { linear: { url: remote.url, headers } },
    });
    for (const file of [".gemini", ".qwen"]) {
      expect(await readJson(join(dir, file, "settings.json"))).toEqual({
        mcpServers: { linear: { httpUrl: remote.url, headers } },
      });
    }
    await syncUserMcpServers([{ ...remote, headers: {} }], {}, options);
    expect(await readJson(join(dir, ".gemini", "settings.json"))).toEqual({
      mcpServers: { linear: { httpUrl: remote.url } },
    });
  });
});
