import { describe, expect, it } from "vitest";

import { scanPlugins } from "./pluginPackage.js";
import { pluginServerConfig, substitute } from "./pluginRuntime.js";

const encoder = new TextEncoder();
const filesOf = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([path, text]) => [path, encoder.encode(text)]));
const skill = (name: string, description = "Does a thing.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

describe("scanPlugins", () => {
  it("reads a Claude Code plugin with skills, servers, commands, settings, and parts it leaves out", () => {
    const scan = scanPlugins(
      filesOf({
        ".claude-plugin/plugin.json": JSON.stringify({
          name: "deploy-kit",
          description: "Ship things.",
          version: "1.2.0",
          userConfig: {
            api_token: { title: "API token", type: "string", sensitive: true, required: true },
            region: { title: "Region", default: "us" },
          },
          hooks: "./hooks/hooks.json",
        }),
        "skills/release/SKILL.md": skill("release"),
        "skills/broken/SKILL.md": "no frontmatter",
        ".mcp.json": JSON.stringify({
          mcpServers: { deploy: { command: "${CLAUDE_PLUGIN_ROOT}/bin/server", args: ["--region", "x"] } },
        }),
        "commands/ship.md": "---\ndescription: Ship the branch\n---\nShip it to ${user_config.region}.",
        "commands/db/migrate.md": "Run migrations.",
        "hooks/hooks.json": "{}",
        "agents/reviewer.md": "x",
      }),
      { fallbackName: "repo" },
    );
    expect(scan.candidates).toHaveLength(1);
    const plugin = scan.candidates[0];
    expect(plugin?.problem).toBeUndefined();
    expect(plugin?.root).toBe("");
    expect(plugin?.descriptor).toMatchObject({
      name: "deploy-kit",
      description: "Ship things.",
      version: "1.2.0",
      format: "claude",
      skills: [{ name: "release", dir: "skills/release" }],
      mcpServers: [{ name: "deploy" }],
      prompts: [
        { name: "db:migrate", description: "", prompt: "Run migrations." },
        { name: "ship", description: "Ship the branch", prompt: "Ship it to ${user_config.region}." },
      ],
      ignored: ["hooks", "subagents"],
    });
    expect(plugin?.descriptor.config).toEqual([
      { key: "api_token", title: "API token", type: "string", sensitive: true, required: true },
      { key: "region", title: "Region", type: "string", sensitive: false, required: false, default: "us" },
    ]);
    expect(plugin?.descriptor.warnings.join(" ")).toContain("broken");
  });

  it("lists every local plugin in a marketplace and the ones that live elsewhere", () => {
    const scan = scanPlugins(
      filesOf({
        ".claude-plugin/marketplace.json": JSON.stringify({
          name: "team-tools",
          metadata: { pluginRoot: "./plugins" },
          plugins: [
            { name: "alpha", source: "./alpha", description: "First" },
            { name: "beta", source: "./beta" },
            { name: "remote", source: { source: "github", repo: "acme/remote" }, description: "Far away" },
            { name: "missing", source: "./missing" },
          ],
        }),
        "plugins/alpha/.claude-plugin/plugin.json": JSON.stringify({ name: "alpha" }),
        "plugins/alpha/commands/hi.md": "Say hi.",
        "plugins/beta/skills/notes/SKILL.md": skill("notes"),
      }),
      { fallbackName: "repo" },
    );
    expect(scan.marketplace).toBe("team-tools");
    expect(
      scan.candidates.map((candidate) => [candidate.root, candidate.descriptor.name, candidate.descriptor.format]),
    ).toEqual([
      ["plugins/alpha", "alpha", "claude"],
      ["plugins/beta", "beta", "folder"],
    ]);
    expect(scan.candidates[1]?.descriptor.description).toBe("");
    expect(scan.elsewhere).toEqual([{ name: "remote", description: "Far away", source: "acme/remote" }]);
  });

  it("reads ZLI actions and Codex display names, and flags a plugin with nothing usable", () => {
    const zli = scanPlugins(
      filesOf({
        "zli-plugin.json": JSON.stringify({
          name: "runner",
          actions: [
            { name: "Run tests", command: "pnpm test", description: "All tests" },
            { name: "Bad", command: "a\nb" },
          ],
        }),
      }),
      { fallbackName: "x" },
    ).candidates[0];
    expect(zli?.descriptor.actions).toEqual([{ name: "Run tests", description: "All tests", command: "pnpm test" }]);
    expect(zli?.descriptor.warnings.join(" ")).toContain("one line");

    const codex = scanPlugins(
      filesOf({
        ".codex-plugin/plugin.json": JSON.stringify({ name: "notes", interface: { displayName: "Notes" } }),
        "skills/notes/SKILL.md": skill("notes"),
      }),
      { fallbackName: "x" },
    ).candidates[0];
    expect(codex?.descriptor).toMatchObject({ displayName: "Notes", format: "codex" });

    const empty = scanPlugins(filesOf({ "zli-plugin.json": JSON.stringify({ name: "empty" }), "README.md": "hi" }), {
      fallbackName: "x",
    }).candidates[0];
    expect(empty?.problem).toContain("no skills");
  });

  it("finds nothing in a folder without plugin parts and rejects bad names", () => {
    expect(scanPlugins(filesOf({ "README.md": "hi" }), { fallbackName: "x" }).candidates).toEqual([]);
    const bad = scanPlugins(
      filesOf({ "zli-plugin.json": JSON.stringify({ name: "Bad Name" }), "commands/a.md": "A" }),
      { fallbackName: "x" },
    ).candidates[0];
    expect(bad?.problem).toContain("naming rule");
  });
});

describe("plugin placeholders", () => {
  const context = {
    root: "/plugins/kit",
    data: "/data/kit",
    config: { token: "secret" },
    env: { HOME_REGION: "eu" },
  };

  it("fills in the folder, data folder, settings, and environment", () => {
    expect(
      substitute(
        "${CLAUDE_PLUGIN_ROOT}/x ${CLAUDE_PLUGIN_DATA} ${user_config.token} ${HOME_REGION} ${NOPE:-dflt}",
        context,
      ),
    ).toEqual({ value: "/plugins/kit/x /data/kit secret eu dflt", missing: [] });
    expect(substitute("${user_config.other}", context)).toEqual({ value: "", missing: ["other"] });
  });

  it("sends remote servers without an Authorization header through sign-in", () => {
    const open = pluginServerConfig({ name: "docs", raw: { type: "http", url: "https://docs.example/mcp" } }, context);
    expect(open).toMatchObject({ server: { transport: "http", oauth: true, url: "https://docs.example/mcp" } });
    const keyed = pluginServerConfig(
      {
        name: "api",
        raw: { url: "https://api.example/mcp", headers: { Authorization: "Bearer ${user_config.token}" } },
      },
      context,
    );
    expect(keyed).toMatchObject({ server: { oauth: false, headers: { Authorization: "Bearer secret" } }, missing: [] });
    const local = pluginServerConfig(
      { name: "local", raw: { command: "${CLAUDE_PLUGIN_ROOT}/run", env: { KEY: "${user_config.key}" } } },
      context,
    );
    expect(local).toMatchObject({ server: { command: "/plugins/kit/run", env: { KEY: "" } }, missing: ["key"] });
    expect(pluginServerConfig({ name: "bad name", raw: { command: "x" } }, context)).toHaveProperty("problem");
  });
});
