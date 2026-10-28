import type { ListedProviderKind, TerminalAgentLaunch } from "@zli-v2/contracts";

import {
  codexMcpArgs,
  gooseMcpArgs,
  type McpConfigFileKind,
  type McpServerSpec,
  opencodeConfigContent,
  writeAgentMcpConfig,
} from "../browser-tool/browserTool.js";

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

/**
 * Interactive CLI arguments for an agent terminal. Permission mode defaults to full access.
 * Read only uses the CLI's plan or read-only mode where it has one; Copilot has none, so it keeps
 * its default of asking before each change.
 */
export function buildAgentArgs(agent: TerminalAgentLaunch): string[] {
  const mode = agent.permissionMode ?? "full-access";
  const fullAccess = mode === "full-access";
  const readOnly = mode === "read-only";
  const model = agent.model === undefined ? undefined : validModel(agent.model);
  switch (agent.provider) {
    case "codex":
      return [
        ...(fullAccess ? ["--dangerously-bypass-approvals-and-sandbox"] : []),
        ...(readOnly ? ["--sandbox", "read-only", "--ask-for-approval", "on-request"] : []),
        ...(model ? ["-m", model] : []),
      ];
    case "claude-code":
      return [
        ...(fullAccess ? ["--dangerously-skip-permissions"] : []),
        // Without a mode, current releases start in Auto mode, where a model decides which actions need asking.
        ...(readOnly ? ["--permission-mode", "plan"] : fullAccess ? [] : ["--permission-mode", "acceptEdits"]),
        ...(model ? ["--model", model] : []),
      ];
    case "cursor-agent":
      return [
        ...(fullAccess ? ["--force"] : []),
        ...(readOnly ? ["--mode", "plan"] : []),
        "--trust",
        ...(model ? ["--model", model] : []),
      ];
    case "droid":
      // Interactive droid has no model flag; the model is chosen inside the TUI.
      return fullAccess ? ["--auto", "high"] : readOnly ? ["--use-spec"] : [];
    case "opencode":
      return [
        ...(fullAccess ? ["--auto"] : []),
        ...(readOnly ? ["--agent", "plan"] : []),
        ...(model ? ["--model", model] : []),
      ];
    case "gemini":
      return [
        ...(fullAccess ? ["--approval-mode", "yolo"] : []),
        ...(readOnly ? ["--approval-mode", "plan"] : []),
        ...(model ? ["--model", model] : []),
      ];
    case "qwen":
      // Without a flag Qwen starts in its Auto mode, where a model decides which actions need asking.
      return [
        "--approval-mode",
        fullAccess ? "yolo" : readOnly ? "plan" : "default",
        ...(model ? ["--model", model] : []),
      ];
    case "copilot":
      return [...(fullAccess ? ["--allow-all"] : []), ...(model ? ["--model", model] : [])];
    case "kimi":
      // Kimi's --yolo still asks when it thinks it should; --auto never asks.
      return [...(fullAccess ? ["--auto"] : []), ...(readOnly ? ["--plan"] : []), ...(model ? ["--model", model] : [])];
    case "goose":
      // goose session has no permission or model flags; see agentModeEnv for its mode.
      return ["session"];
  }
}

/**
 * Environment that sets the permission mode for CLIs without a flag for it. Goose otherwise runs in
 * the mode from its own config, which defaults to auto and never asks.
 */
export function agentModeEnv(agent: TerminalAgentLaunch): Record<string, string> {
  if (agent.provider !== "goose") return {};
  const mode = agent.permissionMode ?? "full-access";
  return { GOOSE_MODE: mode === "full-access" ? "auto" : mode === "supervised" ? "smart_approve" : "chat" };
}

/** CLIs that read MCP servers from a config file passed on their command line. */
export function mcpConfigFileKind(provider: ListedProviderKind): McpConfigFileKind | undefined {
  if (provider === "claude-code") return "claude";
  if (provider === "copilot") return "copilot";
  return undefined;
}

/**
 * Per-launch flags that add MCP servers without editing the CLI's own config.
 * Droid, Gemini, Kimi, and Qwen have no such flag and read them from their user settings;
 * OpenCode reads them from OPENCODE_CONFIG_CONTENT.
 */
export function mcpLaunchArgs(
  provider: ListedProviderKind,
  tool: { specs: readonly McpServerSpec[]; configFile?: string },
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (tool.specs.length === 0) return [];
  switch (provider) {
    case "codex":
      return tool.specs.flatMap(codexMcpArgs);
    case "claude-code":
      // --mcp-config is variadic, so it must stay last or be followed by another flag.
      return tool.configFile ? ["--mcp-config", tool.configFile] : [];
    case "copilot":
      return tool.configFile ? ["--additional-mcp-config", `@${tool.configFile}`] : [];
    case "cursor-agent":
      // The servers come from ~/.cursor/mcp.json; without this Cursor asks before starting them.
      return ["--approve-mcps"];
    case "goose":
      return tool.specs.flatMap((spec) => gooseMcpArgs(spec, platform));
    case "droid":
    case "opencode":
    case "gemini":
    case "kimi":
    case "qwen":
      return [];
  }
}

export type AgentMcpLaunchOptions = {
  /** Where the config file goes for CLIs that take one on the command line. */
  configDir?: string;
  worktreeId: string;
  /** The environment OPENCODE_CONFIG_CONTENT is merged with. */
  env?: NodeJS.ProcessEnv;
  writeMcpConfig?: typeof writeAgentMcpConfig;
};

/** Flags and environment that give one agent launch its MCP servers. A config file that cannot be written leaves its flag out. */
export async function agentMcpLaunch(
  provider: ListedProviderKind,
  specs: readonly McpServerSpec[],
  options: AgentMcpLaunchOptions,
): Promise<{ args: string[]; env: Record<string, string> }> {
  const kind = mcpConfigFileKind(provider);
  let configFile: string | undefined;
  if (kind && options.configDir) {
    try {
      configFile = await (options.writeMcpConfig ?? writeAgentMcpConfig)(
        options.configDir,
        kind,
        options.worktreeId,
        specs,
      );
    } catch {
      configFile = undefined;
    }
  }
  const env: Record<string, string> = {};
  if (provider === "opencode") {
    const content = opencodeConfigContent(specs, (options.env ?? process.env).OPENCODE_CONFIG_CONTENT);
    if (content) env.OPENCODE_CONFIG_CONTENT = content;
  }
  return { args: mcpLaunchArgs(provider, { specs, ...(configFile ? { configFile } : {}) }), env };
}

function validModel(model: string): string {
  if (model.length === 0 || model.length > 200 || model.startsWith("-") || !MODEL_ID.test(model)) {
    throw new AgentLaunchError("The model id contains unsupported characters.");
  }
  return model;
}
