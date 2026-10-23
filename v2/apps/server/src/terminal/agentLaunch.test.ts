import { describe, expect, it } from "vitest";

import { codexMcpArgs, gooseExtension, mcpServerSpec } from "../browser-tool/browserTool.js";
import {
  AgentLaunchError,
  agentCliMissingMessage,
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
    expect(buildAgentArgs({ provider: "kimi" })).toEqual(["--yolo"]);
    expect(buildAgentArgs({ provider: "qwen" })).toEqual(["--approval-mode", "yolo"]);
    expect(buildAgentArgs({ provider: "goose" })).toEqual(["session"]);
  });

  it("drops permission bypass flags in supervised mode", () => {
    expect(buildAgentArgs({ provider: "codex", permissionMode: "supervised" })).toEqual([]);
    expect(buildAgentArgs({ provider: "claude-code", permissionMode: "supervised" })).toEqual([]);
    expect(buildAgentArgs({ provider: "cursor-agent", permissionMode: "supervised" })).toEqual(["--trust"]);
    expect(buildAgentArgs({ provider: "droid", permissionMode: "supervised" })).toEqual([]);
    for (const provider of ["opencode", "gemini", "copilot", "kimi", "qwen"] as const) {
      expect(buildAgentArgs({ provider, permissionMode: "supervised" })).toEqual([]);
    }
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
    for (const provider of ["gemini", "qwen", "copilot"] as const) expect(readOnly(provider)).toEqual([]);
    expect(readOnly("goose")).toEqual(["session"]);
  });

  it("passes the model with each CLI's own flag", () => {
    expect(buildAgentArgs({ provider: "codex", model: "gpt-5.1-codex" })).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
      "-m",
      "gpt-5.1-codex",
    ]);
    expect(
      buildAgentArgs({ provider: "claude-code", model: "claude-sonnet-4-5", permissionMode: "supervised" }),
    ).toEqual(["--model", "claude-sonnet-4-5"]);
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
      "--yolo",
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
    expect(mcpLaunchArgs("cursor-agent", { specs })).toEqual(["--approve-mcps"]);
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

  it("adds nothing for CLIs that read user settings or the environment, or when the config file is missing", () => {
    for (const provider of ["droid", "opencode", "gemini", "kimi", "qwen"] as const) {
      expect(mcpLaunchArgs(provider, { specs })).toEqual([]);
    }
    expect(mcpLaunchArgs("claude-code", { specs })).toEqual([]);
    expect(mcpLaunchArgs("copilot", { specs })).toEqual([]);
    expect(mcpLaunchArgs("cursor-agent", { specs: [] })).toEqual([]);
  });

  it("asks for a config file only from Claude Code and Copilot", () => {
    expect(mcpConfigFileKind("claude-code")).toBe("claude");
    expect(mcpConfigFileKind("copilot")).toBe("copilot");
    expect(mcpConfigFileKind("codex")).toBeUndefined();
  });
});
