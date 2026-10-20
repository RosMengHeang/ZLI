import { AcpProviderError } from "@zli-v2/provider-acp";
import { ClaudeCodeClient, ClaudeProviderError } from "@zli-v2/provider-claude-code";
import { CodexAppServerClient, CodexProviderError } from "@zli-v2/provider-codex";
import { CursorAgentClient, CursorProviderError } from "@zli-v2/provider-cursor-agent";
import { DroidClient, DroidProviderError } from "@zli-v2/provider-droid";

import { type AcpProviderConfig, AcpProviderAdapter, type AcpProviderKind } from "./AcpProviderAdapter.js";
import { ClaudeCodeProviderAdapter } from "./ClaudeCodeProviderAdapter.js";
import { CodexProviderAdapter } from "./CodexProviderAdapter.js";
import { CursorAgentProviderAdapter } from "./CursorAgentProviderAdapter.js";
import { DroidProviderAdapter } from "./DroidProviderAdapter.js";
import { type CliProbe, createDefaultCliProbe, discoverCliProviders } from "./discoverCliProviders.js";
import { MockProviderAdapter } from "./MockProviderAdapter.js";
import { ProviderRegistry } from "./ProviderService.js";

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

export function createProviderRegistry(env: NodeJS.ProcessEnv = process.env): ProviderRegistry {
  if (env.ZLI_TEST_PROVIDER === "mock") return new ProviderRegistry([new MockProviderAdapter()]);
  return new ProviderRegistry([
    new CodexProviderAdapter({
      createClient: async () => CodexAppServerClient.connect({ command: await resolveCodexCommand() }),
    }),
    new ClaudeCodeProviderAdapter({
      createClient: async (input) => ClaudeCodeClient.start({ ...input, command: await resolveClaudeCommand() }),
    }),
    new CursorAgentProviderAdapter({
      createClient: async (input) => CursorAgentClient.start({ ...input, command: await resolveCursorCommand() }),
    }),
    new DroidProviderAdapter({
      createClient: async (input) => DroidClient.start({ ...input, command: await resolveDroidCommand() }),
    }),
    ...ACP_PROVIDERS.map(
      (config) => new AcpProviderAdapter({ ...config, resolveCommand: () => resolveAcpCommand(config.provider) }),
    ),
  ]);
}
