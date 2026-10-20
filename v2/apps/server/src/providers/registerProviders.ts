import { ClaudeCodeClient, ClaudeProviderError } from "@zli-v2/provider-claude-code";
import { CodexAppServerClient, CodexProviderError } from "@zli-v2/provider-codex";
import { CursorAgentClient, CursorProviderError } from "@zli-v2/provider-cursor-agent";
import { DroidClient, DroidProviderError } from "@zli-v2/provider-droid";

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
  ]);
}
