import {
  type ListedProviderKind,
  type ProviderDiscovery,
  type ThreadProjection,
  threadOccupiesWorktree,
} from "@zli-v2/contracts";

/** Picker order. */
export const SELECTABLE_PROVIDERS = [
  "codex",
  "claude-code",
  "cursor-agent",
  "droid",
  "opencode",
  "gemini",
  "copilot",
  "kimi",
  "qwen",
  "goose",
] as const satisfies readonly ListedProviderKind[];

const FALLBACK_NAMES: Record<(typeof SELECTABLE_PROVIDERS)[number], string> = {
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

export function isSelectableProvider(provider: string): provider is ListedProviderKind {
  return (SELECTABLE_PROVIDERS as readonly string[]).includes(provider);
}

export function listedDiscoveries(providers: readonly ProviderDiscovery[] | undefined): ProviderDiscovery[] {
  return (providers ?? []).filter((entry) => isSelectableProvider(entry.provider));
}

export function providerDisplayName(provider: string, providers: readonly ProviderDiscovery[] | undefined): string {
  const match = providers?.find((entry) => entry.provider === provider);
  if (match) return match.displayName;
  if (isSelectableProvider(provider)) return FALLBACK_NAMES[provider];
  return provider;
}

/** Prefer a CLI that discovery already found. Otherwise show the first listed row so its error is visible. */
export function preferredProvider(providers: readonly ProviderDiscovery[]): ListedProviderKind | undefined {
  return providers.find((entry) => entry.status === "found")?.provider ?? providers[0]?.provider;
}

export function worktreeProviderLabel(
  threads: readonly { worktreeId: string; provider: string; status?: ThreadProjection["status"] }[],
  worktreeId: string,
  providers: readonly ProviderDiscovery[] | undefined,
): string | undefined {
  const names: string[] = [];
  for (const thread of threads) {
    if (thread.worktreeId !== worktreeId || !isSelectableProvider(thread.provider)) continue;
    if (thread.status && !threadOccupiesWorktree(thread.status)) continue;
    const name = providerDisplayName(thread.provider, providers);
    if (!names.includes(name)) names.push(name);
  }
  return names.length > 0 ? names.join(", ") : undefined;
}
