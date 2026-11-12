import type {
  HistoryChat,
  HistoryFolder,
  HistorySource,
  ListedProviderKind,
  ProviderDiscovery,
  RuntimeProjection,
} from "@zli-v2/contracts";

export type WelcomeStep = "agents" | "style" | "projects";

export const WELCOME_STEPS: readonly { id: WelcomeStep; label: string }[] = [
  { id: "agents", label: "Agent" },
  { id: "style", label: "Workspace" },
  { id: "projects", label: "Projects" },
];

/** Where setup lands: a new agent in a folder the person added, or the newest chat they imported. */
export function landing(input: {
  style: "chat" | "terminal";
  added: readonly { projectId: string }[];
  imported: readonly { sessionId: string; projectId: string; lastActiveAt: string }[];
}): { kind: "start"; projectId: string } | { kind: "show"; sessionId: string; projectId: string } | { kind: "none" } {
  const newest = [...input.imported].sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt))[0];
  const folder = input.added.at(-1);
  if (folder) return { kind: "start", projectId: folder.projectId };
  if (!newest) return { kind: "none" };
  // A terminal person gets the agent's CLI in that project; a chat person picks the imported chat back up.
  return input.style === "chat"
    ? { kind: "show", sessionId: newest.sessionId, projectId: newest.projectId }
    : { kind: "start", projectId: newest.projectId };
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

/** Claude Code and Codex are shown even when missing, since their chats can also be imported. */
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
 * The agent setup starts with, picked without asking: the saved default when it is installed, else
 * the first ready agent in the order the list shows them.
 */
export function defaultAgent(
  providers: readonly ProviderDiscovery[],
  saved: ListedProviderKind | undefined,
): ProviderDiscovery | undefined {
  const ready = welcomeAgents(providers).shown.filter((entry) => entry.status === "found");
  return ready.find((entry) => entry.provider === saved) ?? ready[0];
}

/** Every chat that can be imported starts ticked, so the folders found are brought in unless unticked. */
export function preselect(folders: readonly HistoryFolder[]): Set<string> {
  return new Set(folders.flatMap((folder) => importableChats(folder).map(chatKey)));
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

export function chatKey(chat: Pick<HistoryChat, "source" | "providerSessionId">): string {
  return `${chat.source}:${chat.providerSessionId}`;
}

/** Chats the person can still pick: the folder is there and the chat is not in ZLI already. */
export function importableChats(folder: HistoryFolder): HistoryChat[] {
  return folder.exists ? folder.chats.filter((chat) => !chat.imported) : [];
}

/** Ticking a folder picks every chat that can still be imported in it; unticking clears them. */
export function toggleFolder(selected: ReadonlySet<string>, folder: HistoryFolder): Set<string> {
  const keys = importableChats(folder).map(chatKey);
  const next = new Set(selected);
  const all = keys.length > 0 && keys.every((key) => next.has(key));
  for (const key of keys) {
    if (all) next.delete(key);
    else next.add(key);
  }
  return next;
}

export function folderState(selected: ReadonlySet<string>, folder: HistoryFolder): "all" | "some" | "none" {
  const keys = importableChats(folder).map(chatKey);
  const count = keys.filter((key) => selected.has(key)).length;
  return count === 0 ? "none" : count === keys.length ? "all" : "some";
}

export type ImportPlan = {
  path: string;
  name: string;
  chats: { source: HistorySource; providerSessionId: string }[];
}[];

/** The folders to add and the chats to bring into each, oldest chat first so the newest ends on top. */
export function importPlan(folders: readonly HistoryFolder[], selected: ReadonlySet<string>): ImportPlan {
  return folders.flatMap((folder) => {
    const chats = importableChats(folder)
      .filter((chat) => selected.has(chatKey(chat)))
      .sort((left, right) => left.lastActiveAt.localeCompare(right.lastActiveAt))
      .map(({ source, providerSessionId }) => ({ source, providerSessionId }));
    return chats.length > 0 ? [{ path: folder.path, name: folder.name, chats }] : [];
  });
}

export function sourceLabel(source: HistorySource): string {
  return source === "claude-code" ? "Claude Code" : "Codex";
}
