import { describe, expect, it } from "vitest";

import { importSources, parseImportFile, scanImportableServers, stripJsonComments } from "./importServers.js";

const HOME = "/home/ada";
const env = { XDG_CONFIG_HOME: "" };

function files(contents: Record<string, string>) {
  return async (path: string): Promise<string> => {
    const text = contents[path];
    if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return text;
  };
}

describe("importSources", () => {
  it("knows where each app keeps its servers on each system", () => {
    expect(importSources({ home: HOME, platform: "linux", env }).map((source) => source.path)).toEqual([
      "/home/ada/.config/Claude/claude_desktop_config.json",
      "/home/ada/.claude.json",
      "/home/ada/.cursor/mcp.json",
      "/home/ada/.config/Code/User/mcp.json",
      "/home/ada/.codeium/windsurf/mcp_config.json",
    ]);
    expect(importSources({ home: "/Users/ada", platform: "darwin", env })[0]?.path).toBe(
      "/Users/ada/Library/Application Support/Claude/claude_desktop_config.json",
    );
    const windows = importSources({
      home: "C:\\Users\\ada",
      platform: "win32",
      env: { APPDATA: "C:\\Users\\ada\\AppData\\Roaming" },
    });
    expect(windows.map((source) => source.path)).toEqual([
      "C:\\Users\\ada\\AppData\\Roaming\\Claude\\claude_desktop_config.json",
      "C:\\Users\\ada\\.claude.json",
      "C:\\Users\\ada\\.cursor\\mcp.json",
      "C:\\Users\\ada\\AppData\\Roaming\\Code\\User\\mcp.json",
      "C:\\Users\\ada\\.codeium\\windsurf\\mcp_config.json",
    ]);
  });
});

describe("parseImportFile", () => {
  const claude = importSources({ home: HOME, platform: "linux", env })[0];
  const vscode = importSources({ home: HOME, platform: "linux", env })[3];
  if (!claude || !vscode) throw new Error("sources missing");

  it("maps local and remote servers, keeps disabled ones off, and renames what agents cannot take", () => {
    const text = JSON.stringify({
      mcpServers: {
        github: { command: "npx", args: ["-y", "gh-mcp"], env: { TOKEN: "t", PORT: 3000 } },
        "Brave Search": { command: "brave-mcp", disabled: true },
        linear: { type: "http", url: "https://mcp.linear.app/mcp" },
        context7: { url: "https://mcp.context7.com/mcp", headers: { Authorization: "Bearer k" } },
        "zli-browser": { command: "zli" },
      },
    });
    expect(parseImportFile(claude, text)).toEqual({
      found: [
        {
          app: "claude-desktop",
          appLabel: "Claude Desktop",
          path: claude.path,
          server: {
            name: "github",
            enabled: true,
            transport: "stdio",
            command: "npx",
            args: ["-y", "gh-mcp"],
            env: { TOKEN: "t", PORT: "3000" },
          },
        },
        expect.objectContaining({
          server: { name: "Brave-Search", enabled: false, transport: "stdio", command: "brave-mcp", args: [], env: {} },
          note: "Renamed from Brave Search, since ZLI names use only letters, digits, - and _.",
        }),
        expect.objectContaining({
          server: {
            name: "linear",
            enabled: true,
            transport: "http",
            url: "https://mcp.linear.app/mcp",
            headers: {},
            oauth: true,
          },
        }),
        expect.objectContaining({
          server: expect.objectContaining({ name: "context7", headers: { Authorization: "Bearer k" }, oauth: false }),
        }),
      ],
      problems: [],
    });
  });

  it("explains servers it skips", () => {
    const text = JSON.stringify({
      mcpServers: {
        plain: { url: "http://mcp.example.com/mcp" },
        nothing: { args: [] },
        odd: "npx thing",
      },
    });
    expect(parseImportFile(claude, text).problems).toEqual([
      "ZLI could not import plain from Claude Desktop. url: Use https://. Plain http:// works only for servers on this computer (localhost).",
      "nothing in Claude Desktop has no command or address, so ZLI skipped it.",
      "odd in Claude Desktop is not set up in a way ZLI understands, so ZLI skipped it.",
    ]);
    expect(parseImportFile(claude, "{ nope").problems).toEqual([
      `ZLI could not read ${claude.path}: it is not plain JSON.`,
    ]);
    expect(parseImportFile(claude, JSON.stringify({ other: 1 }))).toEqual({ found: [], problems: [] });
  });

  it("reads VS Code's servers key with comments, and skips servers that ask for input", () => {
    const text = `{
      // Added by hand
      "servers": {
        "fetch": { "type": "stdio", "command": "uvx", "args": ["mcp-server-fetch"], },
        "gh": { "type": "http", "url": "https://api.githubcopilot.com/mcp/", "headers": { "Authorization": "Bearer \${input:token}" } },
        /* old */
      },
      "inputs": [],
    }`;
    const result = parseImportFile(vscode, text);
    expect(result.found.map((entry) => entry.server.name)).toEqual(["fetch"]);
    expect(result.problems).toEqual(["gh in VS Code asks for a value when it starts, so ZLI skipped it."]);
  });
});

describe("scanImportableServers", () => {
  it("reads every app, skips what ZLI wrote to Cursor, marks names ZLI has, and drops repeats", async () => {
    const shared = { command: "npx", args: ["-y", "gh-mcp"], env: {} };
    const result = await scanImportableServers({
      home: HOME,
      platform: "linux",
      env,
      existing: ["GitHub"],
      owned: { "/home/ada/.cursor/mcp.json": ["sentry"] },
      readFile: files({
        "/home/ada/.claude.json": JSON.stringify({ mcpServers: { github: shared }, projects: {} }),
        "/home/ada/.cursor/mcp.json": JSON.stringify({
          mcpServers: {
            github: shared,
            sentry: { command: "zli-connect" },
            notion: { url: "https://mcp.notion.com/mcp" },
          },
        }),
        "/home/ada/.codeium/windsurf/mcp_config.json": JSON.stringify({
          mcpServers: { figma: { serverUrl: "http://127.0.0.1:3845/mcp" } },
        }),
        "/home/ada/.config/Code/User/mcp.json": "not json",
      }),
    });
    expect(result.found.map((entry) => [entry.app, entry.server.name, entry.exists])).toEqual([
      ["claude-code", "github", true],
      ["cursor", "notion", false],
      ["windsurf", "figma", false],
    ]);
    expect(result.problems).toEqual(["ZLI could not read /home/ada/.config/Code/User/mcp.json: it is not plain JSON."]);
  });

  it("reports a file it is not allowed to open", async () => {
    const result = await scanImportableServers({
      home: HOME,
      platform: "linux",
      env,
      existing: [],
      readFile: async (path) => {
        if (path === "/home/ada/.claude.json") throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });
    expect(result).toEqual({
      found: [],
      problems: ["ZLI could not open /home/ada/.claude.json. Check that you can read it, then try again."],
    });
  });
});

describe("stripJsonComments", () => {
  it("keeps comment-like text inside strings", () => {
    expect(JSON.parse(stripJsonComments('{"a": "http://x//y", /* c */ "b": [1,],}'))).toEqual({
      a: "http://x//y",
      b: [1],
    });
  });
});
