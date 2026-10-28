import { AcpProviderError } from "@zli-v2/provider-acp";
import { ClaudeCodeClient, ClaudeProviderError } from "@zli-v2/provider-claude-code";
import { CodexAppServerClient, CodexProviderError } from "@zli-v2/provider-codex";
import { CursorAgentClient, CursorProviderError } from "@zli-v2/provider-cursor-agent";
import { DroidClient, DroidProviderError } from "@zli-v2/provider-droid";

import {
  agentEnv,
  type BrowserToolConfig,
  codexMcpArgs,
  codexServerConfig,
  codexThreadConfig,
  type McpServerSource,
  type McpServerSpec,
  zliMcpServerSpecs,
  writeAgentMcpConfig,
} from "../browser-tool/browserTool.js";
import { agentFolderTrust } from "../terminal/agentTrust.js";
import { type AcpProviderConfig, AcpProviderAdapter, type AcpProviderKind } from "./AcpProviderAdapter.js";
import { ClaudeCodeProviderAdapter } from "./ClaudeCodeProviderAdapter.js";
import { CodexProviderAdapter } from "./CodexProviderAdapter.js";
import { CursorAgentProviderAdapter } from "./CursorAgentProviderAdapter.js";
import { DroidProviderAdapter } from "./DroidProviderAdapter.js";
import { type CliProbe, createDefaultCliProbe, discoverCliProviders } from "./discoverCliProviders.js";
import { MockProviderAdapter } from "./MockProviderAdapter.js";
import { type ProviderAccount, ProviderRegistry } from "./ProviderService.js";

export async function resolveClaudeCommand(probe: CliProbe = createDefaultCliProbe()): Promise<string> {
  const discovered = await discoverCliProviders(probe, { models: false });
  const claude = discovered.find((entry) => entry.provider === "claude-code");
  if (claude?.status === "found") return claude.path;
  throw new ClaudeProviderError(
    "cli_missing",
    claude?.status === "missing"
      ? claude.reason
      : "Claude Code CLI was not found on PATH or in known install locations.",
  );
}

export async function resolveCodexCommand(probe: CliProbe = createDefaultCliProbe()): Promise<string> {
  const discovered = await discoverCliProviders(probe, { models: false });
  const codex = discovered.find((entry) => entry.provider === "codex");
  if (codex?.status === "found") return codex.path;
  throw new CodexProviderError(
    "request_failed",
    codex?.status === "missing" ? codex.reason : "Codex CLI was not found on PATH or in known install locations.",
  );
}

export async function resolveCursorCommand(probe: CliProbe = createDefaultCliProbe()): Promise<string> {
  const discovered = await discoverCliProviders(probe, { models: false });
  const cursor = discovered.find((entry) => entry.provider === "cursor-agent");
  if (cursor?.status === "found") return cursor.path;
  throw new CursorProviderError(
    "cli_missing",
    cursor?.status === "missing" ? cursor.reason : "Cursor CLI was not found on PATH or in known install locations.",
  );
}

export async function resolveDroidCommand(probe: CliProbe = createDefaultCliProbe()): Promise<string> {
  const discovered = await discoverCliProviders(probe, { models: false });
  const droid = discovered.find((entry) => entry.provider === "droid");
  if (droid?.status === "found") return droid.path;
  throw new DroidProviderError(
    "cli_missing",
    droid?.status === "missing" ? droid.reason : "Droid CLI was not found on PATH or in known install locations.",
  );
}

/**
 * Chat-mode launch for every ACP agent. Gemini CLI before 0.33.0 only knew
 * --experimental-acp; current releases deprecate it in favor of --acp.
 */
export const ACP_PROVIDERS: ReadonlyArray<Omit<AcpProviderConfig, "resolveCommand">> = [
  {
    provider: "opencode",
    displayName: "OpenCode",
    acpArgs: ["acp"],
    authHint: "Sign in to OpenCode in a terminal first (run `opencode auth login`).",
  },
  {
    provider: "gemini",
    displayName: "Gemini",
    acpArgs: ["--acp"],
    authHint: "Sign in to Gemini in a terminal first (run `gemini` and choose a login method).",
  },
  {
    provider: "copilot",
    displayName: "GitHub Copilot",
    acpArgs: ["--acp", "--stdio"],
    authHint: "Sign in to GitHub Copilot in a terminal first (run `copilot`, then `/login`).",
  },
  {
    provider: "kimi",
    displayName: "Kimi Code",
    acpArgs: ["acp"],
    authHint: "Sign in to Kimi Code in a terminal first (run `kimi login`).",
  },
  {
    provider: "qwen",
    displayName: "Qwen Code",
    acpArgs: ["--acp"],
    authHint: "Sign in to Qwen Code in a terminal first (run `qwen` and complete the login).",
  },
  {
    provider: "goose",
    displayName: "Goose",
    acpArgs: ["acp"],
    authHint: "Configure a Goose provider in a terminal first (run `goose configure`).",
  },
];

export async function resolveAcpCommand(
  provider: AcpProviderKind,
  probe: CliProbe = createDefaultCliProbe(),
): Promise<string> {
  const discovered = await discoverCliProviders(probe, { models: false });
  const entry = discovered.find((candidate) => candidate.provider === provider);
  if (entry?.status === "found") return entry.path;
  throw new AcpProviderError(
    "cli_missing",
    entry?.status === "missing" ? entry.reason : `${provider} CLI was not found on PATH or in known install locations.`,
  );
}

export type ProviderRegistryOptions = {
  /** When set, every chat agent gets the zli-browser MCP server and shell command. */
  browserTool?: BrowserToolConfig;
  /** MCP servers added in Settings, read when each chat starts. */
  mcpServers?: McpServerSource;
  /** Where per-chat MCP config files go when there is no browser tool. */
  mcpConfigDir?: string;
  writeMcpConfig?: typeof writeAgentMcpConfig;
};

export function createProviderRegistry(
  env: NodeJS.ProcessEnv = process.env,
  options: ProviderRegistryOptions = {},
): ProviderRegistry {
  if (env.ZLI_TEST_PROVIDER === "mock") return new ProviderRegistry([new MockProviderAdapter()]);
  const browserTool = options.browserTool;
  const writeMcpConfig = options.writeMcpConfig ?? writeAgentMcpConfig;
  const mcpConfigDir = browserTool?.mcpConfigDir ?? options.mcpConfigDir;
  const addedServers = async (worktreeId: string | undefined): Promise<readonly McpServerSpec[]> => {
    try {
      return (await options.mcpServers?.(worktreeId ? { worktreeId } : {})) ?? [];
    } catch {
      return [];
    }
  };
  const allServers = async (worktreeId: string | undefined) => [
    ...(browserTool ? zliMcpServerSpecs(browserTool, worktreeId) : []),
    ...(await addedServers(worktreeId)),
  ];
  // Claude Code, Codex, and Droid take folder trust only from their settings files, so nothing is added to the launch.
  const trustFolder = async (
    provider: "claude-code" | "codex" | "droid",
    {
      cwd,
      account,
      trustedProjectPath,
    }: { cwd: string; account?: ProviderAccount | undefined; trustedProjectPath?: string | undefined },
  ) => {
    if (!trustedProjectPath) return;
    await agentFolderTrust(provider, { projectPath: trustedProjectPath, cwd, env: { ...env, ...account?.env } });
  };
  const browserEnv = (worktreeId: string | undefined, account?: ProviderAccount) => {
    const merged = { ...(browserTool ? agentEnv(browserTool, worktreeId, env) : {}), ...account?.env };
    return Object.keys(merged).length > 0 ? { env: merged } : {};
  };
  const claudeMcpConfig = async (worktreeId: string | undefined) => {
    const specs = await allServers(worktreeId);
    if (!mcpConfigDir || specs.length === 0) return {};
    try {
      return { mcpConfig: await writeMcpConfig(mcpConfigDir, "claude", worktreeId, specs) };
    } catch {
      return {};
    }
  };
  // One app server serves every Codex thread, so servers from Settings join per thread and edits
  // reach the next thread without restarting it.
  const codexThreadOverrides = async (worktreeId: string | undefined) => {
    const config = Object.assign(
      {},
      ...(browserTool ? zliMcpServerSpecs(browserTool, worktreeId).map(codexThreadConfig) : []),
      ...(await addedServers(worktreeId)).map(codexServerConfig),
    );
    return Object.keys(config).length > 0 ? config : undefined;
  };
  return new ProviderRegistry([
    new CodexProviderAdapter({
      // One app server serves every Codex thread, so it starts without a worktree id and each thread adds its own.
      createClient: async ({ account }) =>
        CodexAppServerClient.connect({
          command: await resolveCodexCommand(),
          ...(browserTool ? { args: zliMcpServerSpecs(browserTool).flatMap(codexMcpArgs) } : {}),
          ...browserEnv(undefined, account),
        }),
      threadConfig: async (input) => {
        await trustFolder("codex", input);
        return browserTool || options.mcpServers ? codexThreadOverrides(input.worktreeId) : undefined;
      },
    }),
    new ClaudeCodeProviderAdapter({
      createClient: async ({ worktreeId, account, trustedProjectPath, ...input }) => {
        await trustFolder("claude-code", { cwd: input.cwd, account, trustedProjectPath });
        return ClaudeCodeClient.start({
          ...input,
          command: await resolveClaudeCommand(),
          ...browserEnv(worktreeId, account),
          ...(await claudeMcpConfig(worktreeId)),
        });
      },
    }),
    new CursorAgentProviderAdapter({
      createClient: async ({ worktreeId, account, ...input }) =>
        CursorAgentClient.start({
          ...input,
          command: await resolveCursorCommand(),
          ...browserEnv(worktreeId, account),
          ...((await allServers(worktreeId)).length > 0 ? { approveMcps: true } : {}),
        }),
    }),
    new DroidProviderAdapter({
      createClient: async ({ worktreeId, account, trustedProjectPath, ...input }) => {
        await trustFolder("droid", { cwd: input.cwd, account, trustedProjectPath });
        return DroidClient.start({
          ...input,
          command: await resolveDroidCommand(),
          ...browserEnv(worktreeId, account),
        });
      },
    }),
    ...ACP_PROVIDERS.map(
      (config) =>
        new AcpProviderAdapter({
          ...config,
          resolveCommand: () => resolveAcpCommand(config.provider),
          ...(browserTool ? { browserTool } : {}),
          ...(options.mcpServers ? { mcpServers: (context) => addedServers(context.worktreeId) } : {}),
        }),
    ),
  ]);
}
