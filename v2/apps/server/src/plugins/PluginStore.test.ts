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
    expect((await stat(options.statePath)).mode & 0o777).toBe(0o600);

    let [summary] = (await store.list()).plugins;
    expect(summary?.problems).toEqual(["Add API token in the plugin's settings.", "MCP server local needs API token."]);
    expect(store.mcpServers(new Set()).map((server) => server.name)).toEqual(["docs"]);
    expect(store.skills()).toEqual([{ name: "helper", path: join(folder, "skills", "helper") }]);
    expect(store.contributions().prompts).toEqual([
      { plugin: "kit", name: "ship", description: "", prompt: `Ship from ${folder}.` },
    ]);

    await store.configure("kit", { token: "s3cret" });
    expect(store.mcpServers(new Set())).toContainEqual(
      expect.objectContaining({ name: "local", command: join(folder, "bin/run"), env: { TOKEN: "s3cret" } }),
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

describe("plugin updates and origins", () => {
  const sha1 = "1111111111111111111111111111111111111111";
  const sha2 = "2222222222222222222222222222222222222222";
  const pinnedSha = "3333333333333333333333333333333333333333";

  function github(options: { files: Parameters<typeof githubTarball>[0]; directory?: unknown }) {
    const state = { latest: sha1, commitCalls: 0, limited: false, seen: [] as string[] };
    const tarball = githubTarball(options.files);
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      state.seen.push(url);
      if (url.includes("/tarball")) return new Response(new Uint8Array(tarball));
      if (url.includes("/commits?")) {
        state.commitCalls += 1;
        if (state.limited) return new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
        return Response.json([{ sha: state.latest }]);
      }
      if (url.includes("marketplace.json")) return Response.json(options.directory ?? { plugins: [] });
      return new Response("", { status: 404 });
    }) as typeof fetch;
    return { state, fetchImpl };
  }

  const market = [
    { path: "plugins/two/commands/a.md", text: "A" },
    { path: "plugins/two/.claude-plugin/plugin.json", text: JSON.stringify({ name: "two" }) },
  ];

  it("records the commit, reports updates once GitHub has a newer one, and clears them after updating", async () => {
    let now = Date.parse("2025-01-01T00:00:00.000Z");
    const { state, fetchImpl } = github({ files: market });
    const { store, options } = await setup({ fetch: fetchImpl, now: () => now });
    await store.install("acme/market/plugins/two", ["two"]);
    expect(state.seen).toContain(
      "https://api.github.com/repos/acme/market/commits?sha=HEAD&per_page=1&path=plugins%2Ftwo",
    );
    let [summary] = (await store.list()).plugins;
    expect(summary).toEqual(expect.objectContaining({ sourceKind: "github", origin: "other", commit: sha1 }));
    expect(summary?.updateAvailable).toBeUndefined();
    expect(JSON.parse(await readFile(options.statePath, "utf8")).plugins.two).toEqual(
      expect.objectContaining({ commit: sha1, origin: "other" }),
    );

    [summary] = (await store.checkUpdates()).plugins;
    expect(summary).toEqual(expect.objectContaining({ updateAvailable: false, checkedAt: "2025-01-01T00:00:00.000Z" }));

    state.latest = sha2;
    now += 10 * 60 * 1000;
    [summary] = (await store.checkUpdates()).plugins;
    expect(state.commitCalls).toBe(2);
    expect(summary?.updateAvailable).toBe(false);

    now += 25 * 60 * 1000;
    [summary] = (await store.checkUpdates()).plugins;
    expect(state.commitCalls).toBe(3);
    expect(summary?.updateAvailable).toBe(true);

    await store.update("two");
    [summary] = (await store.list()).plugins;
    expect(summary?.commit).toBe(sha2);
    expect(summary?.updateAvailable).toBeUndefined();
    expect(summary?.checkedAt).toBeUndefined();

    const reloaded = new PluginStore(options);
    await reloaded.load();
    expect((await reloaded.list()).plugins[0]).toEqual(expect.objectContaining({ commit: sha2, sourceKind: "github" }));
  });

  it("reports a GitHub rate limit without failing and never checks pinned or local plugins", async () => {
    let now = 0;
    const { state, fetchImpl } = github({ files: market });
    const { store, source } = await setup({ fetch: fetchImpl, now: () => now });
    await store.install(`https://github.com/acme/market/tree/${pinnedSha}/plugins/two`, ["two"]);
    await store.install(source, ["kit"]);
    expect(state.commitCalls).toBe(0);
    let result = await store.checkUpdates();
    expect(state.commitCalls).toBe(0);
    expect(result.problem).toBeUndefined();
    const byName = () => Object.fromEntries(result.plugins.map((plugin) => [plugin.name, plugin]));
    expect(byName().two).toEqual(
      expect.objectContaining({ pinned: true, commit: pinnedSha, updateAvailable: false, sourceKind: "github" }),
    );
    expect(byName().kit).toEqual(expect.objectContaining({ sourceKind: "local", origin: "other" }));
    expect(byName().kit?.updateAvailable).toBeUndefined();

    await store.remove("two");
    await store.install("acme/market/plugins/two", ["two"]);
    state.limited = true;
    now += 31 * 60 * 1000;
    result = await store.checkUpdates();
    expect(result.problem).toBe("GitHub limited update checks. Try again later.");
    expect(result.plugins.map((plugin) => plugin.name)).toEqual(["kit", "two"]);
    expect(byName().two?.updateAvailable).toBeUndefined();
  });

  it("marks plugins from ZLI's catalog and from Anthropic's directory", async () => {
    const files = [
      { path: "plugins/code-review/commands/code-review.md", text: "Review." },
      { path: "plugins/code-review/.claude-plugin/plugin.json", text: JSON.stringify({ name: "code-review" }) },
      ...market,
    ];
    const directory = {
      plugins: [{ name: "two", source: { source: "github", repo: "acme/market", path: "plugins/two" } }],
    };
    const { fetchImpl } = github({ files, directory });
    const { store } = await setup({ fetch: fetchImpl });
    await store.install("https://github.com/anthropics/claude-plugins-official/tree/v2/plugins/code-review", [
      "code-review",
    ]);
    await store.install("acme/market/plugins/two", ["two"], {}, "anthropic-directory");
    const origins = Object.fromEntries((await store.list()).plugins.map((plugin) => [plugin.name, plugin.origin]));
    expect(origins).toEqual({ "code-review": "zli-catalog", two: "anthropic-directory" });
    expect((await store.directory()).entries.map((entry) => entry.name)).toEqual(["two"]);

    // A claim the directory does not back is not kept.
    const other = await setup({ fetch: github({ files, directory: { plugins: [] } }).fetchImpl });
    await other.store.install("acme/market/plugins/two", ["two"], {}, "anthropic-directory");
    expect((await other.store.list()).plugins[0]?.origin).toBe("other");
  });

  it("offers the commit Anthropic's directory lists now for a pinned plugin installed from it", async () => {
    let now = 0;
    const listed = { source: "github", repo: "acme/market", path: "plugins/two", sha: pinnedSha };
    const directory = { plugins: [{ name: "two", source: listed }] };
    const { fetchImpl } = github({ files: market, directory });
    const { store } = await setup({ fetch: fetchImpl, now: () => now });
    const pinnedSource = `https://github.com/acme/market/tree/${pinnedSha}/plugins/two`;
    await store.install(pinnedSource, ["two"], {}, "anthropic-directory");
    let [summary] = (await store.checkUpdates()).plugins;
    expect(summary).toEqual(
      expect.objectContaining({ origin: "anthropic-directory", pinned: true, updateAvailable: false }),
    );

    listed.sha = sha2;
    now += 61 * 60 * 1000;
    [summary] = (await store.checkUpdates()).plugins;
    expect(summary?.updateAvailable).toBe(true);

    await store.update("two");
    [summary] = (await store.list()).plugins;
    expect(summary).toEqual(
      expect.objectContaining({
        source: `https://github.com/acme/market/tree/${sha2}/plugins/two`,
        commit: sha2,
        pinned: true,
        origin: "anthropic-directory",
      }),
    );
    expect(summary?.updateAvailable).toBeUndefined();
  });

  it("reads plugin settings saved before updates and origins existed", async () => {
    const { options } = await setup();
    await mkdir(dirname(options.statePath), { recursive: true });
    await writeFile(
      options.statePath,
      JSON.stringify({
        version: 1,
        plugins: {
          old: {
            enabled: true,
            source: "https://github.com/acme/old",
            installedAt: "2024-01-01T00:00:00.000Z",
            descriptor: { name: "old", displayName: "Old", description: "", format: "folder", skills: [] },
            config: {},
          },
        },
      }),
    );
    const store = new PluginStore(options);
    await store.load();
    const [summary] = (await store.list()).plugins;
    expect(summary).toEqual(expect.objectContaining({ name: "old", origin: "other", sourceKind: "github" }));
    expect(summary?.commit).toBeUndefined();
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
