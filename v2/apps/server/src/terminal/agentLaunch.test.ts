import { describe, expect, it } from "vitest";

import { codexMcpArgs, gooseExtension, mcpServerSpec } from "../browser-tool/browserTool.js";
import {
  AgentLaunchError,
  agentCliMissingMessage,
  browserToolArgs,
  browserToolConfigFileKind,
  buildAgentArgs,
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

describe("browserToolArgs", () => {
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

  it("registers the MCP server per launch with each CLI's own flag", () => {
    expect(browserToolArgs("codex", { spec })).toEqual(codexMcpArgs(spec));
    expect(browserToolArgs("claude-code", { spec, configFile: "C:\\ZLI\\data\\mcp\\claude-wt.json" })).toEqual([
      "--mcp-config",
      "C:\\ZLI\\data\\mcp\\claude-wt.json",
    ]);
    expect(browserToolArgs("copilot", { spec, configFile: "C:\\ZLI\\data\\mcp\\copilot-wt.json" })).toEqual([
      "--additional-mcp-config",
      "@C:\\ZLI\\data\\mcp\\copilot-wt.json",
    ]);
    expect(browserToolArgs("cursor-agent", { spec })).toEqual(["--approve-mcps"]);
    expect(browserToolArgs("goose", { spec }, "win32")).toEqual(["--with-extension", gooseExtension(spec, "win32")]);
  });

  it("adds nothing for CLIs that read user settings or the environment, or when the config file is missing", () => {
    for (const provider of ["droid", "opencode", "gemini", "kimi", "qwen"] as const) {
      expect(browserToolArgs(provider, { spec })).toEqual([]);
    }
    expect(browserToolArgs("claude-code", { spec })).toEqual([]);
    expect(browserToolArgs("copilot", { spec })).toEqual([]);
  });

  it("asks for a config file only from Claude Code and Copilot", () => {
    expect(browserToolConfigFileKind("claude-code")).toBe("claude");
    expect(browserToolConfigFileKind("copilot")).toBe("copilot");
    expect(browserToolConfigFileKind("codex")).toBeUndefined();
  });
});
