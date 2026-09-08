export function canonicalProviderId(id: string): string {
  if (id === "claude") return "claude-code";
  if (id === "cursor") return "cursor-agent";
  return id;
}

export const PROVIDER_ACCENTS: Record<string, string> = {
  "claude-code": "#D97757",
  claude: "#D97757",
  codex: "#9ad7c2",
  "cursor-agent": "#e8e8e8",
  cursor: "#e8e8e8",
  opencode: "#f0eeea",
  gemini: "#9b87c4",
  aider: "#fb923c",
  goose: "#3ecc5f",
  shell: "#6fbf4b",
};

export interface ProviderVisualIdentity {
  mark: string;
  label: string;
  accent: string;
}

export function providerVisualIdentity(id: string): ProviderVisualIdentity {
  const canonicalId = canonicalProviderId(id);
  if (canonicalId === "claude-code") {
    return {
      mark: "claude",
      label: "Claude Code",
      accent: PROVIDER_ACCENTS[canonicalId],
    };
  }

  return {
    mark: canonicalId,
    label: canonicalId,
    accent: PROVIDER_ACCENTS[canonicalId] ?? "#2563eb",
  };
}

export function providerAccent(id: string | undefined): string {
  if (!id) return PROVIDER_ACCENTS.shell;
  return PROVIDER_ACCENTS[canonicalProviderId(id)] ?? "#2563eb";
}
