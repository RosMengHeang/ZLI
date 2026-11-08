import { describe, expect, it } from "vitest";

import { codexMcpArgs, gooseExtension, mcpServerSpec, opencodeConfigContent } from "../browser-tool/browserTool.js";
import { PROJECT_MCP_FILES, projectMcpFileContents } from "../browser-tool/mcpSettingsFiles.js";
import {
  AgentLaunchError,
  agentCliMissingMessage,
  agentMcpLaunch,
  agentModeEnv,
  buildAgentArgs,
  mcpConfigFileKind,
  mcpLaunchArgs,
} from "./agentLaunch.js";

describe("buildAgentArgs", () => {
  it("defaults every provider to full access", () => {
    expect(buildAgentArgs({ provider: "codex" })).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
    expect(buildAgentArgs({ provider: "claude-code" })).toEqual(["--dangerously-skip-permissions"]);
    expect(buildAgentArgs({ provider: "cursor-agent" })).toEqual(["--force", "--trust"]);
    expect(buildAgentArgs({ provider: "droid" })).toEqual(["--auto", "high"]);
    expect(buildAgentArgs({ provider: "opencode" })).toEqual(["--auto"]);
    expect(buildAgentArgs({ provider: "gemini" })).toEqual(["--approval-mode", "yolo"]);
    expect(buildAgentArgs({ provider: "copilot" })).toEqual(["--allow-all"]);
    expect(buildAgentArgs({ provider: "kimi" })).toEqual(["--auto"]);
    expect(buildAgentArgs({ provider: "qwen" })).toEqual(["--approval-mode", "yolo"]);
    expect(buildAgentArgs({ provider: "goose" })).toEqual(["session"]);
  });

  it("drops permission bypass flags in supervised mode", () => {
    expect(buildAgentArgs({ provider: "codex", permissionMode: "supervised" })).toEqual([]);
    expect(buildAgentArgs({ provider: "claude-code", permissionMode: "supervised" })).toEqual([
      "--permission-mode",
      "acceptEdits",
    ]);
    expect(buildAgentArgs({ provider: "cursor-agent", permissionMode: "supervised" })).toEqual(["--trust"]);
    expect(buildAgentArgs({ provider: "droid", permissionMode: "supervised" })).toEqual([]);
    for (const provider of ["opencode", "gemini", "copilot", "kimi"] as const) {
      expect(buildAgentArgs({ provider, permissionMode: "supervised" })).toEqual([]);
    }
    expect(buildAgentArgs({ provider: "qwen", permissionMode: "supervised" })).toEqual(["--approval-mode", "default"]);
    expect(buildAgentArgs({ provider: "goose", permissionMode: "supervised" })).toEqual(["session"]);
  });

  it("uses each CLI's plan or read-only mode in read-only mode", () => {
    const readOnly = (provider: Parameters<typeof buildAgentArgs>[0]["provider"]) =>
      buildAgentArgs({ provider, permissionMode: "read-only" });
    expect(readOnly("codex")).toEqual(["--sandbox", "read-only", "--ask-for-approval", "on-request"]);
    expect(readOnly("claude-code")).toEqual(["--permission-mode", "plan"]);
    expect(readOnly("cursor-agent")).toEqual(["--mode", "plan", "--trust"]);
    expect(readOnly("droid")).toEqual(["--use-spec"]);
    expect(readOnly("opencode")).toEqual(["--agent", "plan"]);
    expect(readOnly("kimi")).toEqual(["--plan"]);
    expect(readOnly("gemini")).toEqual(["--approval-mode", "plan"]);
    expect(readOnly("qwen")).toEqual(["--approval-mode", "plan"]);
    expect(readOnly("copilot")).toEqual([]);
    expect(readOnly("goose")).toEqual(["session"]);
  });

  it("sets Goose's mode through GOOSE_MODE, since goose session has no flag for it", () => {
    expect(agentModeEnv({ provider: "goose" })).toEqual({ GOOSE_MODE: "auto" });
    expect(agentModeEnv({ provider: "goose", permissionMode: "supervised" })).toEqual({ GOOSE_MODE: "smart_approve" });
    expect(agentModeEnv({ provider: "goose", permissionMode: "read-only" })).toEqual({ GOOSE_MODE: "chat" });
    expect(agentModeEnv({ provider: "claude-code", permissionMode: "supervised" })).toEqual({});
  });

  it("passes the model with each CLI's own flag", () => {
    expect(buildAgentArgs({ provider: "codex", model: "gpt-5.1-codex" })).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
      "-m",
      "gpt-5.1-codex",
    ]);
    expect(
      buildAgentArgs({ provider: "claude-code", model: "claude-sonnet-4-5", permissionMode: "supervised" }),
    ).toEqual(["--permission-mode", "acceptEdits", "--model", "claude-sonnet-4-5"]);
    expect(buildAgentArgs({ provider: "cursor-agent", model: "claude-opus-4-8[context=1m,effort=high]" })).toEqual([
      "--force",
      "--trust",
      "--model",
      "claude-opus-4-8[context=1m,effort=high]",
    ]);
    expect(buildAgentArgs({ provider: "droid", model: "gpt-5" })).toEqual(["--auto", "high"]);
    expect(buildAgentArgs({ provider: "opencode", model: "openai/gpt-5" })).toEqual([
      "--auto",
      "--model",
      "openai/gpt-5",
    ]);
    expect(buildAgentArgs({ provider: "gemini", model: "gemini-3.1-pro", permissionMode: "supervised" })).toEqual([
      "--model",
      "gemini-3.1-pro",
    ]);
    expect(buildAgentArgs({ provider: "copilot", model: "claude-sonnet-4.5" })).toEqual([
      "--allow-all",
      "--model",
      "claude-sonnet-4.5",
    ]);
    expect(buildAgentArgs({ provider: "kimi", model: "kimi-k2.7-code" })).toEqual([
      "--auto",
      "--model",
      "kimi-k2.7-code",
    ]);
    expect(buildAgentArgs({ provider: "qwen", model: "qwen3-coder-plus" })).toEqual([
      "--approval-mode",
      "yolo",
      "--model",
      "qwen3-coder-plus",
    ]);
    expect(buildAgentArgs({ provider: "goose", model: "gpt-5" })).toEqual(["session"]);
    expect(() => buildAgentArgs({ provider: "goose", model: "gpt 5" })).toThrow(AgentLaunchError);
  });

  it.each([
    "gpt 5",
    'gpt"5',
    "gpt&calc",
    "gpt|calc",
    "gpt%PATH%",
    "gpt^5",
    "gpt!x!",
    "gpt>out",
    "--dangerously-skip-permissions",
    "gpt\n5",
  ])("rejects the unsafe model id %j", (model) => {
    expect(() => buildAgentArgs({ provider: "claude-code", model })).toThrow(AgentLaunchError);
  });

  it("names the missing CLI", () => {
    expect(agentCliMissingMessage("cursor-agent")).toBe("Cursor CLI was not found. Install it or check PATH.");
    expect(agentCliMissingMessage("claude-code")).toBe("Claude Code CLI was not found. Install it or check PATH.");
    expect(agentCliMissingMessage("copilot")).toBe("GitHub Copilot CLI was not found. Install it or check PATH.");
    expect(agentCliMissingMessage("kimi")).toBe("Kimi Code CLI was not found. Install it or check PATH.");
  });
});

describe("mcpLaunchArgs", () => {
  const spec = mcpServerSpec(
    {
      command: "C:\\ZLI\\ZLI.exe",
      script: "C:\\ZLI\\zli-browser.js",
      controlFile: "C:\\ZLI\\data\\browser-control.json",
      shimDir: "C:\\ZLI\\data\\bin",
      mcpConfigDir: "C:\\ZLI\\data\\mcp",
    },
    "00000000-0000-4000-8000-000000000302",
  );
  const added = { name: "github", command: "npx", args: ["-y", "gh-mcp"], env: { TOKEN: "t" } };
  const specs = [spec];

  it("registers the MCP server per launch with each CLI's own flag", () => {
    expect(mcpLaunchArgs("codex", { specs })).toEqual(codexMcpArgs(spec));
    expect(mcpLaunchArgs("claude-code", { specs, configFile: "C:\\ZLI\\data\\mcp\\claude-wt.json" })).toEqual([
      "--mcp-config",
      "C:\\ZLI\\data\\mcp\\claude-wt.json",
    ]);
    expect(mcpLaunchArgs("copilot", { specs, configFile: "C:\\ZLI\\data\\mcp\\copilot-wt.json" })).toEqual([
      "--additional-mcp-config",
      "@C:\\ZLI\\data\\mcp\\copilot-wt.json",
    ]);
    expect(mcpLaunchArgs("cursor-agent", { specs, worktreeFile: true })).toEqual(["--approve-mcps"]);
    expect(mcpLaunchArgs("goose", { specs }, "win32")).toEqual(["--with-extension", gooseExtension(spec, "win32")]);
  });

  it("repeats per-server flags for every server", () => {
    expect(mcpLaunchArgs("codex", { specs: [spec, added] })).toEqual([...codexMcpArgs(spec), ...codexMcpArgs(added)]);
    expect(mcpLaunchArgs("goose", { specs: [spec, added] }, "linux")).toEqual([
      "--with-extension",
      gooseExtension(spec, "linux"),
      "--with-extension",
      gooseExtension(added, "linux"),
    ]);
  });

  it("passes remote servers by URL, skipping Goose ones that need headers", () => {
    const figma = { transport: "http" as const, name: "figma", url: "http://127.0.0.1:3845/mcp", headers: {} };
    const linear = {
      ...figma,
      name: "linear",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer t" },
    };
    expect(mcpLaunchArgs("goose", { specs: [figma, linear] }, "linux")).toEqual([
      "--with-streamable-http-extension",
      figma.url,
    ]);
    expect(mcpLaunchArgs("codex", { specs: [linear] })).toEqual(codexMcpArgs(linear));
  });

  it("adds nothing for CLIs that read a project file or the environment, or when the config file is missing", () => {
    for (const provider of ["droid", "opencode", "gemini", "kimi", "qwen"] as const) {
      expect(mcpLaunchArgs(provider, { specs, worktreeFile: true })).toEqual([]);
    }
    expect(mcpLaunchArgs("claude-code", { specs })).toEqual([]);
    expect(mcpLaunchArgs("copilot", { specs })).toEqual([]);
    expect(mcpLaunchArgs("cursor-agent", { specs })).toEqual([]);
    expect(mcpLaunchArgs("cursor-agent", { specs: [], worktreeFile: true })).toEqual([]);
  });

  it.each(["cursor-agent", "droid", "kimi", "gemini", "qwen"] as const)(
    "writes %s's servers into its project MCP file in the worktree",
    async (provider) => {
      const written: unknown[] = [];
      const launch = await agentMcpLaunch(provider, specs, {
        worktreeId: "wt-1",
        worktreePath: "/repo-worktrees/feature",
        writeWorktreeFile: async (worktreePath, relPath, contents) => {
          written.push({ worktreePath, relPath, contents });
          return true;
        },
      });
      expect(written).toEqual([
        {
          worktreePath: "/repo-worktrees/feature",
          relPath: PROJECT_MCP_FILES[provider],
          contents: projectMcpFileContents(provider, specs),
        },
      ]);
      expect(launch).toEqual({ args: provider === "cursor-agent" ? ["--approve-mcps"] : [], env: {} });
    },
  );

  it("never approves Cursor servers from a project file that is not ZLI's", async () => {
    const leftAlone = await agentMcpLaunch("cursor-agent", specs, {
      worktreeId: "wt-1",
      worktreePath: "/repo",
      writeWorktreeFile: async () => false,
    });
    expect(leftAlone).toEqual({ args: [], env: {} });
    const failed = await agentMcpLaunch("cursor-agent", specs, {
      worktreeId: "wt-1",
      worktreePath: "/repo",
      writeWorktreeFile: async () => {
        throw new Error("read-only file system");
      },
    });
    expect(failed).toEqual({ args: [], env: {} });
  });

  it("removes ZLI's project file when there are no servers, and writes nothing for other CLIs", async () => {
    const written: unknown[] = [];
    const writeWorktreeFile = async (_worktreePath: string, relPath: string, contents: string | undefined) => {
      written.push({ relPath, contents });
      return contents !== undefined;
    };
    await agentMcpLaunch("droid", [], { worktreeId: "wt-1", worktreePath: "/repo", writeWorktreeFile });
    await agentMcpLaunch("codex", specs, { worktreeId: "wt-1", worktreePath: "/repo", writeWorktreeFile });
    await agentMcpLaunch("opencode", specs, { worktreeId: "wt-1", worktreePath: "/repo", writeWorktreeFile, env: {} });
    expect(written).toEqual([{ relPath: ".factory/mcp.json", contents: undefined }]);
  });

  it("writes the config file and passes it to Claude Code", async () => {
    const written: unknown[] = [];
    const launch = await agentMcpLaunch("claude-code", specs, {
      configDir: "/data/mcp",
      worktreeId: "wt-1",
      writeMcpConfig: async (dir, kind, worktreeId, given) => {
        written.push({ dir, kind, worktreeId, given });
        return "/data/mcp/claude-wt-1.json";
      },
    });
    expect(written).toEqual([{ dir: "/data/mcp", kind: "claude", worktreeId: "wt-1", given: specs }]);
    expect(launch).toEqual({ args: ["--mcp-config", "/data/mcp/claude-wt-1.json"], env: {} });
  });

  it("leaves the config flag out when the file cannot be written", async () => {
    const launch = await agentMcpLaunch("copilot", specs, {
      configDir: "/data/mcp",
      worktreeId: "wt-1",
      writeMcpConfig: async () => {
        throw new Error("disk full");
      },
    });
    expect(launch).toEqual({ args: [], env: {} });
  });

  it("gives OpenCode its servers in OPENCODE_CONFIG_CONTENT, merged with the person's own", async () => {
    const existing = JSON.stringify({ theme: "dark" });
    const launch = await agentMcpLaunch("opencode", specs, {
      worktreeId: "wt-1",
      env: { OPENCODE_CONFIG_CONTENT: existing },
    });
    expect(launch).toEqual({ args: [], env: { OPENCODE_CONFIG_CONTENT: opencodeConfigContent(specs, existing) } });
  });

  it("asks for a config file only from Claude Code and Copilot", () => {
    expect(mcpConfigFileKind("claude-code")).toBe("claude");
    expect(mcpConfigFileKind("copilot")).toBe("copilot");
    expect(mcpConfigFileKind("codex")).toBeUndefined();
  });
});
