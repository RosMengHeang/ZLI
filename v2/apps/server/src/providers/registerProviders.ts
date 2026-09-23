import { ClaudeCodeClient, ClaudeProviderError } from "@zli-v2/provider-claude-code";
import { CodexAppServerClient } from "@zli-v2/provider-codex";

import { ClaudeCodeProviderAdapter } from "./ClaudeCodeProviderAdapter.js";
import { CodexProviderAdapter } from "./CodexProviderAdapter.js";
import { type CliProbe, createDefaultCliProbe, discoverCliProviders } from "./discoverCliProviders.js";
import { MockProviderAdapter } from "./MockProviderAdapter.js";
import { ProviderRegistry } from "./ProviderService.js";

export async function resolveClaudeCommand(probe: CliProbe = createDefaultCliProbe()): Promise<string> {
  const discovered = await discoverCliProviders(probe);
  const claude = discovered.find((entry) => entry.provider === "claude-code");
  if (claude?.status === "found") return claude.path;
  throw new ClaudeProviderError(
    "cli_missing",
    claude?.status === "missing"
      ? claude.reason
      : "Claude Code CLI was not found on PATH or in known install locations.",
  );
}

export function createProviderRegistry(env: NodeJS.ProcessEnv = process.env): ProviderRegistry {
  if (env.ZLI_TEST_PROVIDER === "mock") return new ProviderRegistry([new MockProviderAdapter()]);
  return new ProviderRegistry([
    new CodexProviderAdapter({ createClient: () => CodexAppServerClient.connect() }),
    new ClaudeCodeProviderAdapter({
      createClient: async ({ cwd }) => ClaudeCodeClient.start({ cwd, command: await resolveClaudeCommand() }),
    }),
  ]);
}
