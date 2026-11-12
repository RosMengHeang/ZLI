import type { HistoryFolder, ListedProviderKind, ProviderDiscovery, RuntimeProjection } from "@zli-v2/contracts";

import { agentReady } from "../agent/providers.js";

export { agentReady, planLabel, signInCommand } from "../agent/providers.js";

export type WelcomeStep = "agents" | "style" | "projects";

export const WELCOME_STEPS: readonly { id: WelcomeStep; label: string }[] = [
  { id: "agents", label: "Agent" },
  { id: "style", label: "Workspace" },
  { id: "projects", label: "Projects" },
];

/**
 * The project setup opens an agent in: the folder added by hand last, else the most recently used of
 * the folders kept ticked.
 */
export function landingPath(
  folders: readonly HistoryFolder[],
  selected: ReadonlySet<string>,
  added: readonly { path: string }[],
): string | undefined {
  return added.at(-1)?.path ?? folders.find((folder) => selected.has(folder.path))?.path;
}

/**
 * The welcome flow is for a fresh install: nothing in ZLI yet and the flow never finished or skipped.
 * Someone upgrading with projects already set up never sees it.
 */
export function shouldWelcome(
  onboardedAt: string | undefined,
  projection: Pick<RuntimeProjection, "projects" | "threads" | "terminals"> | undefined,
): boolean {
  if (onboardedAt || !projection) return false;
  return projection.projects.length === 0 && projection.threads.length === 0 && projection.terminals.length === 0;
}

/** Claude Code and Codex are always listed, since they are the agents most people start with. */
const PRIMARY: readonly ListedProviderKind[] = ["claude-code", "codex"];

export function welcomeAgents(providers: readonly ProviderDiscovery[]): {
  shown: ProviderDiscovery[];
  more: ProviderDiscovery[];
} {
  const shown = providers.filter((entry) => PRIMARY.includes(entry.provider) || entry.status === "found");
  const more = providers.filter((entry) => !shown.includes(entry));
  const rank = (entry: ProviderDiscovery) =>
    (entry.status === "found" ? 0 : 2) + (PRIMARY.includes(entry.provider) ? 0 : 1);
  return { shown: [...shown].sort((left, right) => rank(left) - rank(right)), more };
}

/**
 * The agent setup starts with, picked without asking: the saved default when it is ready, else the first
 * ready agent in the order the list shows them, else the first installed one.
 */
export function defaultAgent(
  providers: readonly ProviderDiscovery[],
  saved: ListedProviderKind | undefined,
): ProviderDiscovery | undefined {
  const installed = welcomeAgents(providers).shown.filter((entry) => entry.status === "found");
  const ready = installed.filter(agentReady);
  return ready.find((entry) => entry.provider === saved) ?? ready[0] ?? installed[0];
}

/** Nothing starts ticked: the person picks the projects to bring in, or ticks them all at once. */
export function preselect(_folders: readonly HistoryFolder[]): Set<string> {
  return new Set();
}

/** Every folder found, for "Select all". */
export function allFolders(folders: readonly HistoryFolder[]): Set<string> {
  return new Set(folders.map((folder) => folder.path));
}

export type InstallPlatform = "windows" | "posix";

/**
 * Install commands from each agent's own documentation. Agents without a single documented command
 * are left out, and the card says only that the CLI was not found.
 */
const INSTALL: Partial<Record<ListedProviderKind, Record<InstallPlatform, string>>> = {
  "claude-code": {
    windows: "irm https://claude.ai/install.ps1 | iex",
    posix: "curl -fsSL https://claude.ai/install.sh | bash",
  },
  codex: { windows: "npm install -g @openai/codex", posix: "npm install -g @openai/codex" },
  gemini: { windows: "npm install -g @google/gemini-cli", posix: "npm install -g @google/gemini-cli" },
  copilot: { windows: "npm install -g @github/copilot", posix: "npm install -g @github/copilot" },
  opencode: { windows: "npm install -g opencode-ai", posix: "npm install -g opencode-ai" },
  qwen: { windows: "npm install -g @qwen-code/qwen-code", posix: "npm install -g @qwen-code/qwen-code" },
};

export function installCommand(provider: ListedProviderKind, platform: InstallPlatform): string | undefined {
  return INSTALL[provider]?.[platform];
}

export function installPlatform(userAgent: string): InstallPlatform {
  return userAgent.includes("Windows") ? "windows" : "posix";
}

/** The ticked folders, in the order they are listed: most recently used first. */
export function selectedFolders(folders: readonly HistoryFolder[], selected: ReadonlySet<string>): HistoryFolder[] {
  return folders.filter((folder) => selected.has(folder.path));
}
