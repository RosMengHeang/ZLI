import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { McpServerStore } from "../mcp/McpServerStore.js";
import { fakeFetch, githubTarball } from "../skills/testTarball.js";
import { PluginStore, type PluginStoreOptions } from "./PluginStore.js";
import { runPluginCommand } from "./runPluginCommand.js";

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

const skill = (name: string) => `---\nname: ${name}\ndescription: Helps.\n---\n\n# ${name}\n`;

async function writeTree(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
}

const kit = {
  ".claude-plugin/plugin.json": JSON.stringify({
    name: "kit",
    description: "Tools.",
    userConfig: { token: { title: "API token", sensitive: true, required: true } },
  }),
  ".mcp.json": JSON.stringify({
    mcpServers: {
      local: { command: "${CLAUDE_PLUGIN_ROOT}/bin/run", env: { TOKEN: "${user_config.token}" } },
      docs: { type: "http", url: "https://docs.example/mcp" },
    },
  }),
  "skills/helper/SKILL.md": skill("helper"),
  "commands/ship.md": "Ship from ${CLAUDE_PLUGIN_ROOT}.",
};

async function setup(extra: Partial<PluginStoreOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "zli-plugins-"));
  temps.push(root);
  const source = join(root, "source");
  await writeTree(source, kit);
  const options: PluginStoreOptions = {
    pluginsDir: join(root, "data", "plugins"),
    dataDir: join(root, "data", "plugin-data"),
    statePath: join(root, "data", "plugins.json"),
    env: {},
    ...extra,
  };
  const store = new PluginStore(options);
  await store.load();
  return { root, source, options, store };
}

describe("PluginStore", () => {
  it("installs a local plugin and hands its parts to agents once its settings are filled in", async () => {
    let changes = 0;
    const { source, options, store } = await setup({
      onChange: async () => {
        changes += 1;
      },
    });
    const preview = await store.previewInstall(source);
    expect(preview.candidates).toEqual([
      expect.objectContaining({ name: "kit", path: ".", exists: false, format: "claude" }),
    ]);
    await store.install(source, ["kit"]);
    expect(changes).toBe(1);
    const folder = join(options.pluginsDir, "kit");
    expect(await readFile(join(folder, "skills/helper/SKILL.md"), "utf8")).toContain("helper");
    expect((await stat(join(options.dataDir, "kit"))).isDirectory()).toBe(true);
    if (process.platform !== "win32") expect((await stat(options.statePath)).mode & 0o777).toBe(0o600);

    let [summary] = (await store.list()).plugins;
    expect(summary?.problems).toEqual(["Add API token in the plugin's settings.", "MCP server local needs API token."]);
    expect(store.mcpServers(new Set()).map((server) => server.name)).toEqual(["docs"]);
    expect(store.skills()).toEqual([{ name: "helper", path: join(folder, "skills", "helper") }]);
    expect(store.contributions().prompts).toEqual([
      { plugin: "kit", name: "ship", description: "", prompt: `Ship from ${folder}.` },
    ]);

    await store.configure("kit", { token: "s3cret" });
    expect(store.mcpServers(new Set())).toContainEqual(
      expect.objectContaining({ name: "local", command: `${folder}/bin/run`, env: { TOKEN: "s3cret" } }),
    );
    // A blank value keeps the saved secret.
    await store.configure("kit", { token: "" });
    [summary] = (await store.list()).plugins;
    expect(summary?.configured).toEqual(["token"]);
    expect(summary?.problems).toEqual([]);
    expect(JSON.stringify(summary)).not.toContain("s3cret");

    // The person's own server names win.
    expect(store.mcpServers(new Set(["docs"])).map((server) => server.name)).toEqual(["local"]);

    const reloaded = new PluginStore(options);
    await reloaded.load();
    expect(reloaded.mcpServers(new Set()).map((server) => server.name)).toEqual(["local", "docs"]);

    await store.setEnabled("kit", false);
    expect(store.mcpServers(new Set())).toEqual([]);
    expect(store.skills()).toEqual([]);
    expect(store.contributions()).toEqual({ prompts: [], actions: [] });

    await store.remove("kit");
    expect((await store.list()).plugins).toEqual([]);
    await expect(stat(folder)).rejects.toThrow();
  });

  it("updates from the saved source and reports names other sources already use", async () => {
    const { source, store } = await setup({ userSkillNames: async () => ["helper"], userServerNames: () => ["Docs"] });
    await store.install(source, ["kit"], { kit: { token: "t" } });
    const [summary] = (await store.list()).plugins;
    expect(summary?.problems).toEqual([
      "MCP server docs is not added: your MCP list already has that name.",
      "Skill helper is not copied to agents: one of your own skills has that name.",
    ]);
    await writeFile(join(source, "commands/extra.md"), "Extra prompt.");
    await store.update("kit");
    expect(store.contributions().prompts.map((prompt) => prompt.name)).toEqual(["extra", "ship"]);
    await expect(store.update("nope")).rejects.toThrow("no plugin named nope");
  });

  it("installs chosen plugins from a GitHub marketplace", async () => {
    const tarball = githubTarball([
      {
        path: ".claude-plugin/marketplace.json",
        text: JSON.stringify({
          name: "market",
          plugins: [
            { name: "one", source: "./plugins/one" },
            { name: "two", source: "./plugins/two" },
          ],
        }),
      },
      { path: "plugins/one/commands/a.md", text: "A" },
      {
        path: "plugins/two/zli-plugin.json",
        text: JSON.stringify({ name: "two", actions: [{ name: "Test", command: "npm test" }] }),
      },
    ]);
    const seen: string[] = [];
    const { store } = await setup({ fetch: fakeFetch(tarball, seen) });
    const result = (await runPluginCommand(store, {
      type: "plugins.install",
      source: "acme/market",
      names: ["two"],
    })) as { installed: string[]; plugins: Array<{ name: string; source: string }> };
    expect(result.installed).toEqual(["two"]);
    expect(result.plugins).toEqual([
      expect.objectContaining({ name: "two", source: "https://github.com/acme/market/tree/HEAD/plugins/two" }),
    ]);
    expect(store.contributions().actions).toEqual([
      { plugin: "two", name: "Test", description: "", command: "npm test" },
    ]);
    await expect(store.install("acme/market", ["three"])).rejects.toThrow("three is not in that source");
  });

  it("rejects sources that are neither a folder nor a GitHub repository", async () => {
    const { store, root } = await setup();
    await expect(store.previewInstall("not a source")).rejects.toThrow();
    await expect(store.previewInstall(join(root, "missing"))).rejects.toThrow("does not exist");
  });
});

describe("plugin servers in the MCP list", () => {
  it("adds plugin servers after the person's own and writes header files for sign-in servers", async () => {
    const root = await mkdtemp(join(tmpdir(), "zli-plugin-mcp-"));
    temps.push(root);
    const path = join(root, "mcp-servers.json");
    let taken: string[] = [];
    const store = new McpServerStore({
      path,
      extraServers: (names) => {
        taken = [...names];
        return [
          {
            name: "remote",
            enabled: true,
            transport: "http",
            url: "https://x.example/mcp",
            headers: { "X-Key": "k" },
            oauth: true,
          },
        ];
      },
    });
    await store.load();
    await store.save([{ name: "Mine", enabled: false, transport: "stdio", command: "mine", args: [], env: {} }]);
    expect(taken).toEqual(["mine"]);
    expect(store.specs().map((spec) => spec.name)).toEqual(["remote"]);
    await store.refresh();
    expect(await readFile(store.headerFile("remote"), "utf8")).toBe("X-Key: k\n");
  });
});
