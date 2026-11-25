import type { ListedProviderKind } from "./provider.js";

export type InstallPlatform = "windows" | "posix";

/**
 * Install commands copied from each agent's own install docs. Kimi Code and Goose have no single
 * documented command, so they link to their install page instead.
 */
const INSTALL_COMMANDS: Partial<Record<ListedProviderKind, Record<InstallPlatform, string>>> = {
  "claude-code": {
    windows: "irm https://claude.ai/install.ps1 | iex",
    posix: "curl -fsSL https://claude.ai/install.sh | bash",
  },
  codex: { windows: "npm install -g @openai/codex", posix: "npm install -g @openai/codex" },
  "cursor-agent": {
    windows: "irm 'https://cursor.com/install?win32=true' | iex",
    posix: "curl https://cursor.com/install -fsS | bash",
  },
  droid: {
    windows: "irm https://app.factory.ai/cli/windows | iex",
    posix: "curl -fsSL https://app.factory.ai/cli | sh",
  },
  gemini: { windows: "npm install -g @google/gemini-cli", posix: "npm install -g @google/gemini-cli" },
  copilot: { windows: "npm install -g @github/copilot", posix: "npm install -g @github/copilot" },
  opencode: { windows: "npm install -g opencode-ai", posix: "npm install -g opencode-ai" },
  qwen: { windows: "npm install -g @qwen-code/qwen-code", posix: "npm install -g @qwen-code/qwen-code" },
  grok: { windows: "irm https://x.ai/cli/install.ps1 | iex", posix: "curl -fsSL https://x.ai/cli/install.sh | bash" },
};

const INSTALL_PAGES: Partial<Record<ListedProviderKind, string>> = {
  kimi: "https://github.com/MoonshotAI/kimi-cli",
  goose: "https://github.com/aaif-goose/goose",
};

export function installCommand(provider: ListedProviderKind, platform: InstallPlatform): string | undefined {
  return INSTALL_COMMANDS[provider]?.[platform];
}

export function installPage(provider: ListedProviderKind): string | undefined {
  return INSTALL_PAGES[provider];
}

/** The sentence that follows "CLI was not found": how to install it, or where to read how. */
export function installHint(provider: ListedProviderKind, platform: InstallPlatform): string | undefined {
  const command = installCommand(provider, platform);
  if (command) return `Install it with \`${command}\`, then try again.`;
  const page = installPage(provider);
  return page ? `Install it from ${page}, then try again.` : undefined;
}
