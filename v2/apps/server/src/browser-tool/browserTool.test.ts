import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  acpMcpServer,
  agentEnv,
  type BrowserToolConfig,
  browserToolConfigFromEnv,
  claudeMcpConfig,
  codexMcpArgs,
  codexServerConfig,
  codexThreadConfig,
  copilotMcpConfig,
  gooseExtension,
  mcpServerSpec,
  opencodeConfigContent,
  pathKey,
  prependPath,
  writeMcpConfigFile,
} from "./browserTool.js";

const WORKTREE = "00000000-0000-4000-8000-000000000302";

const config: BrowserToolConfig = {
  command: "C:\\Users\\O'Neil Dev\\AppData\\Local\\Programs\\ZLI\\ZLI.exe",
  script: "C:\\Users\\O'Neil Dev\\AppData\\Local\\Programs\\ZLI\\resources\\dist\\zli-browser.js",
  controlFile: "C:\\Users\\dev\\AppData\\Roaming\\ZLI\\browser-control.json",
  shimDir: "C:\\Users\\dev\\AppData\\Roaming\\ZLI\\bin",
  mcpConfigDir: "C:\\Users\\dev\\AppData\\Roaming\\ZLI\\mcp",
};

const fullEnv = {
  ZLI_BROWSER_TOOL_COMMAND: "/opt/zli/zli",
  ZLI_BROWSER_TOOL_SCRIPT: "/opt/zli/resources/zli-browser.js",
  ZLI_BROWSER_CONTROL_FILE: "/home/dev/.config/zli/browser-control.json",
  ZLI_BROWSER_SHIM_DIR: "/home/dev/.config/zli/bin",
};

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("browserToolConfigFromEnv", () => {
  it("reads all four paths and puts MCP files next to the control file", () => {
    expect(browserToolConfigFromEnv(fullEnv)).toEqual({
      command: "/opt/zli/zli",
      script: "/opt/zli/resources/zli-browser.js",
      controlFile: "/home/dev/.config/zli/browser-control.json",
      shimDir: "/home/dev/.config/zli/bin",
      mcpConfigDir: join("/home/dev/.config/zli", "mcp"),
    });
  });

  it.each(Object.keys(fullEnv))("is undefined when %s is missing or blank", (key) => {
    expect(browserToolConfigFromEnv({ ...fullEnv, [key]: undefined })).toBeUndefined();
    expect(browserToolConfigFromEnv({ ...fullEnv, [key]: "  " })).toBeUndefined();
  });

  it("is undefined for relative paths", () => {
    expect(browserToolConfigFromEnv({ ...fullEnv, ZLI_BROWSER_SHIM_DIR: "bin" })).toBeUndefined();
  });
});

describe("PATH handling", () => {
  it("reuses the Windows spelling of the PATH key", () => {
    expect(pathKey({ Path: "C:\\Windows" }, "win32")).toBe("Path");
    expect(pathKey({ PATH: "C:\\Windows" }, "win32")).toBe("PATH");
    expect(pathKey({}, "win32")).toBe("Path");
    expect(pathKey({ Path: "/usr/bin" }, "linux")).toBe("PATH");
  });

  it("prepends once and leaves a single PATH key on Windows", () => {
    const env = prependPath(
      { Path: "C:\\Windows;c:\\users\\dev\\appdata\\roaming\\zli\\bin", PATH: "stale", Other: "x" },
      config.shimDir,
      "win32",
    );
    expect(env).toEqual({ Path: `${config.shimDir};C:\\Windows`, Other: "x" });
  });

  it("prepends on POSIX with a colon", () => {
    expect(prependPath({ PATH: "/usr/bin:/bin" }, "/opt/zli/bin", "linux")).toEqual({
      PATH: "/opt/zli/bin:/usr/bin:/bin",
    });
    expect(prependPath({}, "/opt/zli/bin", "linux")).toEqual({ PATH: "/opt/zli/bin" });
  });

  it("gives an agent the control file, its worktree, and the shim on PATH", () => {
    expect(agentEnv(config, WORKTREE, { Path: "C:\\Windows" }, "win32")).toEqual({
      ZLI_BROWSER_CONTROL_FILE: config.controlFile,
      ZLI_WORKTREE_ID: WORKTREE,
      Path: `${config.shimDir};C:\\Windows`,
    });
    expect(agentEnv(config, undefined, {}, "linux")).toEqual({
      ZLI_BROWSER_CONTROL_FILE: config.controlFile,
      PATH: config.shimDir,
    });
  });
});

describe("MCP server definitions", () => {
  it("runs the tool script under Electron as Node and names the worktree when known", () => {
    expect(mcpServerSpec(config, WORKTREE)).toEqual({
      name: "zli-browser",
      command: config.command,
      args: [config.script, "mcp"],
      env: { ELECTRON_RUN_AS_NODE: "1", ZLI_BROWSER_CONTROL_FILE: config.controlFile, ZLI_WORKTREE_ID: WORKTREE },
    });
    expect(mcpServerSpec(config).env).toEqual({
      ELECTRON_RUN_AS_NODE: "1",
      ZLI_BROWSER_CONTROL_FILE: config.controlFile,
    });
  });

  it("uses the ACP stdio shape with env as name/value pairs", () => {
    expect(acpMcpServer(mcpServerSpec(config, WORKTREE))).toEqual({
      name: "zli-browser",
      command: config.command,
      args: [config.script, "mcp"],
      env: [
        { name: "ELECTRON_RUN_AS_NODE", value: "1" },
        { name: "ZLI_BROWSER_CONTROL_FILE", value: config.controlFile },
        { name: "ZLI_WORKTREE_ID", value: WORKTREE },
      ],
    });
  });

  it("writes Claude Code and Copilot config files", () => {
    const spec = mcpServerSpec(config, WORKTREE);
    expect(JSON.parse(claudeMcpConfig(spec))).toEqual({
      mcpServers: { "zli-browser": { type: "stdio", command: spec.command, args: spec.args, env: spec.env } },
    });
    expect(JSON.parse(copilotMcpConfig(spec))).toEqual({
      mcpServers: {
        "zli-browser": { type: "local", command: spec.command, args: spec.args, env: spec.env, tools: ["*"] },
      },
    });
  });

  it("lists every server in one config file", () => {
    const spec = mcpServerSpec(config, WORKTREE);
    const github = { name: "github", command: "npx", args: ["-y", "gh-mcp"], env: { TOKEN: "t" } };
    expect(Object.keys(JSON.parse(claudeMcpConfig([spec, github])).mcpServers)).toEqual(["zli-browser", "github"]);
    expect(JSON.parse(copilotMcpConfig([github])).mcpServers.github).toEqual({
      type: "local",
      command: "npx",
      args: ["-y", "gh-mcp"],
      env: { TOKEN: "t" },
      tools: ["*"],
    });
    expect(Object.keys(JSON.parse(opencodeConfigContent([spec, github]) ?? "").mcp)).toEqual(["zli-browser", "github"]);
  });

  it("merges into the user's OPENCODE_CONFIG_CONTENT and gives up on one it cannot read", () => {
    const spec = mcpServerSpec(config, WORKTREE);
    const local = { type: "local", command: [spec.command, ...spec.args], environment: spec.env, enabled: true };
    expect(JSON.parse(opencodeConfigContent(spec) ?? "")).toEqual({ mcp: { "zli-browser": local } });
    expect(
      JSON.parse(opencodeConfigContent(spec, JSON.stringify({ model: "x", mcp: { mine: { type: "remote" } } })) ?? ""),
    ).toEqual({ model: "x", mcp: { mine: { type: "remote" }, "zli-browser": local } });
    expect(opencodeConfigContent(spec, "{ not json")).toBeUndefined();
    expect(opencodeConfigContent(spec, "[]")).toBeUndefined();
  });

  it("builds a Goose extension command with env assignments and forward slashes on Windows", () => {
    const spec = mcpServerSpec(
      { ...config, command: "C:\\ZLI\\ZLI.exe", script: "C:\\ZLI\\resources\\zli-browser.js" },
      WORKTREE,
    );
    expect(gooseExtension(spec, "win32")).toBe(
      `ELECTRON_RUN_AS_NODE=1 ZLI_BROWSER_CONTROL_FILE=C:/Users/dev/AppData/Roaming/ZLI/browser-control.json ZLI_WORKTREE_ID=${WORKTREE} C:/ZLI/ZLI.exe C:/ZLI/resources/zli-browser.js mcp`,
    );
    expect(gooseExtension({ ...spec, command: "/opt/my apps/zli" }, "linux")).toContain("'/opt/my apps/zli' ");
  });
});

describe("Codex -c overrides", () => {
  it("emits TOML that parses back to the server definition, including quotes and backslashes", () => {
    const spec = mcpServerSpec(config, WORKTREE);
    const args = codexMcpArgs(spec);
    expect(args.filter((_, index) => index % 2 === 0)).toEqual(["-c", "-c", "-c"]);
    const overrides = Object.fromEntries(
      args
        .filter((_, index) => index % 2 === 1)
        .map((override) => {
          const equals = override.indexOf("=");
          return [override.slice(0, equals), parseToml(override.slice(equals + 1))];
        }),
    );
    expect(overrides).toEqual({
      "mcp_servers.zli-browser.command": spec.command,
      "mcp_servers.zli-browser.args": spec.args,
      "mcp_servers.zli-browser.env": spec.env,
    });
  });

  it("uses literal strings for plain Windows paths so no double quotes reach cmd.exe", () => {
    const spec = mcpServerSpec({ ...config, command: "C:\\ZLI\\ZLI.exe", script: "C:\\ZLI\\zli-browser.js" });
    expect(codexMcpArgs(spec)).toEqual([
      "-c",
      "mcp_servers.zli-browser.command='C:\\ZLI\\ZLI.exe'",
      "-c",
      "mcp_servers.zli-browser.args=['C:\\ZLI\\zli-browser.js', 'mcp']",
      "-c",
      `mcp_servers.zli-browser.env={ ELECTRON_RUN_AS_NODE = '1', ZLI_BROWSER_CONTROL_FILE = '${config.controlFile}' }`,
    ]);
  });

  it("overrides only the env table per thread", () => {
    expect(codexThreadConfig(mcpServerSpec(config, WORKTREE))).toEqual({
      "mcp_servers.zli-browser.env": {
        ELECTRON_RUN_AS_NODE: "1",
        ZLI_BROWSER_CONTROL_FILE: config.controlFile,
        ZLI_WORKTREE_ID: WORKTREE,
      },
    });
  });

  it("adds a whole server per thread", () => {
    expect(codexServerConfig({ name: "github", command: "npx", args: ["-y"], env: { TOKEN: "t" } })).toEqual({
      "mcp_servers.github": { command: "npx", args: ["-y"], env: { TOKEN: "t" } },
    });
  });
});

describe("writeMcpConfigFile", () => {
  it("writes one file per worktree and leaves it untouched when nothing changed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zli-mcp-"));
    temps.push(dir);
    const local = { ...config, mcpConfigDir: join(dir, "mcp") };
    const path = await writeMcpConfigFile(local, "claude", WORKTREE);
    expect(path).toBe(join(dir, "mcp", `claude-${WORKTREE}.json`));
    expect(await readFile(path, "utf8")).toBe(claudeMcpConfig(mcpServerSpec(local, WORKTREE)));
    const before = (await stat(path)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeMcpConfigFile(local, "claude", WORKTREE);
    expect((await stat(path)).mtimeMs).toBe(before);

    await writeFile(path, "stale", "utf8");
    await writeMcpConfigFile(local, "claude", WORKTREE);
    expect(await readFile(path, "utf8")).toBe(claudeMcpConfig(mcpServerSpec(local, WORKTREE)));
    const copilot = await writeMcpConfigFile(local, "copilot", undefined);
    expect(copilot).toBe(join(dir, "mcp", "copilot-shared.json"));
    expect((await readdir(join(dir, "mcp"))).sort()).toEqual([`claude-${WORKTREE}.json`, "copilot-shared.json"]);
  });
});

/** Just enough TOML to read back what codexMcpArgs emits: strings, arrays, and inline tables. */
function parseToml(source: string): unknown {
  let index = 0;
  const skip = () => {
    while (source[index] === " ") index += 1;
  };
  const value = (): unknown => {
    skip();
    const char = source[index];
    if (char === "'") {
      const end = source.indexOf("'", index + 1);
      const text = source.slice(index + 1, end);
      index = end + 1;
      return text;
    }
    if (char === '"') {
      let end = index + 1;
      while (source[end] !== '"') end += source[end] === "\\" ? 2 : 1;
      const text = JSON.parse(source.slice(index, end + 1)) as string;
      index = end + 1;
      return text;
    }
    if (char === "[") {
      index += 1;
      const items: unknown[] = [];
      skip();
      while (source[index] !== "]") {
        items.push(value());
        skip();
        if (source[index] === ",") index += 1;
        skip();
      }
      index += 1;
      return items;
    }
    if (char === "{") {
      index += 1;
      const table: Record<string, unknown> = {};
      skip();
      while (source[index] !== "}") {
        const keyMatch = /^[A-Za-z0-9_-]+/u.exec(source.slice(index));
        if (!keyMatch) throw new Error(`Bad key at ${index}`);
        index += keyMatch[0].length;
        skip();
        if (source[index] !== "=") throw new Error(`Expected = at ${index}`);
        index += 1;
        table[keyMatch[0]] = value();
        skip();
        if (source[index] === ",") index += 1;
        skip();
      }
      index += 1;
      return table;
    }
    throw new Error(`Unexpected ${char} at ${index}`);
  };
  const result = value();
  skip();
  if (index !== source.length) throw new Error(`Trailing input at ${index}`);
  return result;
}
