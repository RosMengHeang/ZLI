import { ClaudeCodeClient, ClaudeProviderError } from "@zli-v2/provider-claude-code";
import { CodexAppServerClient } from "@zli-v2/provider-codex";
import { CursorAgentClient, CursorProviderError } from "@zli-v2/provider-cursor-agent";

import { ClaudeCodeProviderAdapter } from "./ClaudeCodeProviderAdapter.js";
import { CodexProviderAdapter } from "./CodexProviderAdapter.js";
import { CursorAgentProviderAdapter } from "./CursorAgentProviderAdapter.js";
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

export async function resolveCursorCommand(probe: CliProbe = createDefaultCliProbe()): Promise<string> {
  const discovered = await discoverCliProviders(probe);
  const cursor = discovered.find((entry) => entry.provider === "cursor-agent");
  if (cursor?.status === "found") return cursor.path;
  throw new CursorProviderError(
    "cli_missing",
    cursor?.status === "missing" ? cursor.reason : "Cursor CLI was not found on PATH or in known install locations.",
  );
}

export function createProviderRegistry(env: NodeJS.ProcessEnv = process.env): ProviderRegistry {
  if (env.ZLI_TEST_PROVIDER === "mock") return new ProviderRegistry([new MockProviderAdapter()]);
  return new ProviderRegistry([
    new CodexProviderAdapter({ createClient: () => CodexAppServerClient.connect() }),
    new ClaudeCodeProviderAdapter({
      createClient: async ({ cwd }) => ClaudeCodeClient.start({ cwd, command: await resolveClaudeCommand() }),
    }),
    new CursorAgentProviderAdapter({
      createClient: async ({ cwd }) => CursorAgentClient.start({ cwd, command: await resolveCursorCommand() }),
    }),
  ]);
}
