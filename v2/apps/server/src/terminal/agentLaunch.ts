import type { ListedProviderKind, TerminalAgentLaunch } from "@zli-v2/contracts";

import { codexMcpArgs, gooseExtension, type McpServerSpec } from "../browser-tool/browserTool.js";

/**
 * Model ids reach cmd.exe when the CLI is an npm .cmd shim, so only characters that real
 * provider model ids use are allowed. Cursor's parameterized ids need [ ] = and commas.
 */
const MODEL_ID = /^[A-Za-z0-9._:/[\]=,-]+$/u;

const DISPLAY_NAMES: Record<ListedProviderKind, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  "cursor-agent": "Cursor",
  droid: "Droid",
  opencode: "OpenCode",
  gemini: "Gemini",
  copilot: "GitHub Copilot",
  kimi: "Kimi Code",
  qwen: "Qwen Code",
  goose: "Goose",
};

/** Agent TUIs probe these to pick their color depth; ConPTY does not set them. */
export const AGENT_PTY_ENV: Readonly<Record<string, string>> = {
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
};

export class AgentLaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentLaunchError";
  }
}

export function agentDisplayName(provider: ListedProviderKind): string {
  return DISPLAY_NAMES[provider];
}

export function agentCliMissingMessage(provider: ListedProviderKind): string {
  return `${agentDisplayName(provider)} CLI was not found. Install it or check PATH.`;
}

/** Interactive CLI arguments for an agent terminal. Permission mode defaults to full access. */
export function buildAgentArgs(agent: TerminalAgentLaunch): string[] {
  const fullAccess = (agent.permissionMode ?? "full-access") === "full-access";
  const model = agent.model === undefined ? undefined : validModel(agent.model);
  switch (agent.provider) {
    case "codex":
      return [...(fullAccess ? ["--dangerously-bypass-approvals-and-sandbox"] : []), ...(model ? ["-m", model] : [])];
    case "claude-code":
      return [...(fullAccess ? ["--dangerously-skip-permissions"] : []), ...(model ? ["--model", model] : [])];
    case "cursor-agent":
      return [...(fullAccess ? ["--force"] : []), "--trust", ...(model ? ["--model", model] : [])];
    case "droid":
      // Interactive droid has no model flag; the model is chosen inside the TUI.
      return fullAccess ? ["--auto", "high"] : [];
    case "opencode":
      return [...(fullAccess ? ["--auto"] : []), ...(model ? ["--model", model] : [])];
    case "gemini":
    case "qwen":
      return [...(fullAccess ? ["--approval-mode", "yolo"] : []), ...(model ? ["--model", model] : [])];
    case "copilot":
      return [...(fullAccess ? ["--allow-all"] : []), ...(model ? ["--model", model] : [])];
    case "kimi":
      return [...(fullAccess ? ["--yolo"] : []), ...(model ? ["--model", model] : [])];
    case "goose":
      // goose session has no permission or model flags; GOOSE_MODE and GOOSE_MODEL in its config decide both.
      return ["session"];
  }
}

/** CLIs that read the browser MCP server from a config file passed on their command line. */
export function browserToolConfigFileKind(provider: ListedProviderKind): "claude" | "copilot" | undefined {
  if (provider === "claude-code") return "claude";
  if (provider === "copilot") return "copilot";
  return undefined;
}

/**
 * Per-launch flags that add the zli-browser MCP server without editing the CLI's own config.
 * Droid, Gemini, Kimi, and Qwen have no such flag and read it from their user settings;
 * OpenCode reads it from OPENCODE_CONFIG_CONTENT.
 */
export function browserToolArgs(
  provider: ListedProviderKind,
  tool: { spec: McpServerSpec; configFile?: string },
  platform: NodeJS.Platform = process.platform,
): string[] {
  switch (provider) {
    case "codex":
      return codexMcpArgs(tool.spec);
    case "claude-code":
      // --mcp-config is variadic, so it must stay last or be followed by another flag.
      return tool.configFile ? ["--mcp-config", tool.configFile] : [];
    case "copilot":
      return tool.configFile ? ["--additional-mcp-config", `@${tool.configFile}`] : [];
    case "cursor-agent":
      // The server comes from ~/.cursor/mcp.json; without this Cursor asks before starting it.
      return ["--approve-mcps"];
    case "goose":
      return ["--with-extension", gooseExtension(tool.spec, platform)];
    case "droid":
    case "opencode":
    case "gemini":
    case "kimi":
    case "qwen":
      return [];
  }
}

function validModel(model: string): string {
  if (model.length === 0 || model.length > 200 || model.startsWith("-") || !MODEL_ID.test(model)) {
    throw new AgentLaunchError("The model id contains unsupported characters.");
  }
  return model;
}
