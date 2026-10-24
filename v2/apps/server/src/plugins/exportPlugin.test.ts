import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { McpServerConfig } from "@zli-v2/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { exportPlugin, type PluginExportSources } from "./exportPlugin.js";
import { PluginStore } from "./PluginStore.js";

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

const servers: McpServerConfig[] = [
  {
    name: "local",
    enabled: true,
    transport: "stdio",
    command: "run-it",
    args: ["--fast"],
    env: { API_KEY: "s3cret-env" },
  },
  { name: "docs", enabled: true, transport: "http", url: "https://docs.example/mcp", headers: { X: "h" }, oauth: true },
  {
    name: "api",
    enabled: false,
    transport: "http",
    url: "https://api.example/mcp",
    headers: { Authorization: "Bearer s3cret-header" },
    oauth: false,
  },
];

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "zli-export-"));
  temps.push(root);
  const library = join(root, "library");
  const write = async (path: string, text: string) => {
    await mkdir(dirname(join(library, path)), { recursive: true });
    await writeFile(join(library, path), text);
  };
  await write("helper/SKILL.md", "---\nname: helper\ndescription: Helps.\n---\n\nSteps.\n");
  await write("helper/scripts/run.sh", "echo hi\n");
  await write("other/SKILL.md", "---\nname: other\ndescription: Other.\n---\n");
  const sources: PluginExportSources = {
    skills: async () => [
      { name: "helper", path: join(library, "helper") },
      { name: "other", path: join(library, "other") },
    ],
    servers: () => servers,
  };
  return { root, sources };
}

describe("exportPlugin", () => {
  it("writes a Claude Code plugin with settings in place of secrets", async () => {
    const { root, sources } = await setup();
    const folder = join(root, "out", "kit");
    const result = await exportPlugin(
      { folder, name: "kit", displayName: "My kit", skills: ["helper"], servers: ["local", "docs", "API"] },
      sources,
    );
    expect(result).toEqual({
      folder,
      files: [
        ".claude-plugin/plugin.json",
        ".mcp.json",
        "README.md",
        "skills/helper/scripts/run.sh",
        "skills/helper/SKILL.md",
      ],
    });
    const manifest = JSON.parse(await readFile(join(folder, ".claude-plugin/plugin.json"), "utf8"));
    expect(manifest).toEqual({
      name: "kit",
      displayName: "My kit",
      description: "1 skill and 3 MCP servers exported from ZLI.",
      version: "0.1.0",
      userConfig: {
        local_API_KEY: expect.objectContaining({ title: "API_KEY for local", sensitive: true, required: true }),
        api_Authorization: expect.objectContaining({ title: "Authorization for api", sensitive: true, required: true }),
      },
    });
    expect(JSON.parse(await readFile(join(folder, ".mcp.json"), "utf8"))).toEqual({
      mcpServers: {
        local: { command: "run-it", args: ["--fast"], env: { API_KEY: "${user_config.local_API_KEY}" } },
        docs: { type: "http", url: "https://docs.example/mcp" },
        api: {
          type: "http",
          url: "https://api.example/mcp",
          headers: { Authorization: "${user_config.api_Authorization}" },
        },
      },
    });
    const readme = await readFile(join(folder, "README.md"), "utf8");
    expect(readme).toContain("# My kit");
    expect(readme).toContain("Settings, Plugins, Install plugin, then pick this folder.");
    expect(readme).not.toMatch(/[\u2013\u2014]/u);
    const everything = await Promise.all(result.files.map((path) => readFile(join(folder, path), "utf8")));
    expect(everything.join("\n")).not.toContain("s3cret");
    expect(await readFile(join(folder, "skills/helper/scripts/run.sh"), "utf8")).toBe("echo hi\n");

    // ZLI installs the export again and asks for the settings that replaced the secrets.
    const store = new PluginStore({
      pluginsDir: join(root, "data", "plugins"),
      dataDir: join(root, "data", "plugin-data"),
      statePath: join(root, "data", "plugins.json"),
      env: {},
    });
    await store.load();
    await store.install(folder, ["kit"], { kit: { local_API_KEY: "k1", api_Authorization: "Bearer k2" } });
    const [summary] = (await store.list()).plugins;
    expect(summary).toEqual(expect.objectContaining({ name: "kit", displayName: "My kit", problems: [] }));
    expect(summary?.components.skills).toEqual(["helper"]);
    expect(store.mcpServers(new Set())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "local", env: { API_KEY: "k1" } }),
        expect.objectContaining({ name: "api", headers: { Authorization: "Bearer k2" }, oauth: false }),
        expect.objectContaining({ name: "docs", oauth: true }),
      ]),
    );
  });

  it("refuses folders that are not empty and names that do not exist", async () => {
    const { root, sources } = await setup();
    const base = { name: "kit", skills: ["helper"], servers: [] };
    await expect(exportPlugin({ ...base, folder: "relative/kit" }, sources)).rejects.toThrow("full path");
    await mkdir(join(root, "full"));
    await writeFile(join(root, "full", "x.txt"), "x");
    await expect(exportPlugin({ ...base, folder: join(root, "full") }, sources)).rejects.toThrow(
      "Pick an empty folder.",
    );
    await expect(exportPlugin({ ...base, folder: join(root, "full", "x.txt") }, sources)).rejects.toThrow(
      "Pick an empty folder.",
    );
    await expect(exportPlugin({ ...base, folder: join(root, "a"), skills: ["missing"] }, sources)).rejects.toThrow(
      "There is no skill named missing.",
    );
    await expect(
      exportPlugin({ ...base, folder: join(root, "a"), skills: [], servers: ["nope"] }, sources),
    ).rejects.toThrow("There is no MCP server named nope.");
    await expect(exportPlugin({ ...base, folder: join(root, "a"), skills: [] }, sources)).rejects.toThrow(
      "Pick at least one skill or MCP server.",
    );
    await mkdir(join(root, "empty"));
    const result = await exportPlugin({ ...base, folder: join(root, "empty"), description: "Mine." }, sources);
    expect(result.files).not.toContain(".mcp.json");
    expect(JSON.parse(await readFile(join(root, "empty", ".claude-plugin/plugin.json"), "utf8"))).toEqual({
      name: "kit",
      description: "Mine.",
      version: "0.1.0",
    });
  });
});
