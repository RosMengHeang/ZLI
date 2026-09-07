export function canonicalProviderId(id: string): string {
  if (id === "claude") return "claude-code";
  if (id === "cursor") return "cursor-agent";
  return id;
}

export const PROVIDER_ACCENTS: Record<string, string> = {
  "claude-code": "#d4a37a",
  claude: "#d4a37a",
  codex: "#9ad7c2",
  "cursor-agent": "#e8e8e8",
  cursor: "#e8e8e8",
  opencode: "#f0eeea",
  gemini: "#9b87c4",
  aider: "#fb923c",
  goose: "#3ecc5f",
  shell: "#6fbf4b",
};

export function providerAccent(id: string | undefined): string {
  if (!id) return PROVIDER_ACCENTS.shell;
  return PROVIDER_ACCENTS[canonicalProviderId(id)] ?? "#2563eb";
}
