import { agentTitle } from "@zli-v2/client-runtime";
import type {
  PermissionMode,
  ProjectProjection,
  ProviderDiscovery,
  RuntimeProjection,
  TerminalProjection,
  ThreadActivityProjection,
  ThreadProjection,
  ThreadQueuedMessage,
  ThreadRequestProjection,
  WorktreeProjection,
} from "@zli-v2/contracts";
import { worktreeHasLiveThread } from "@zli-v2/contracts";
import { worktreeRoot } from "@zli-v2/remote-protocol";

export { agentTitle, providerName, threadMessages } from "@zli-v2/client-runtime";

export type Tone = "neutral" | "blue" | "green" | "amber" | "red";
export type StatusView = { label: string; tone: Tone };

export function threadStatus(thread: Pick<ThreadProjection, "status">, openRequests: number): StatusView {
  if (openRequests > 0 || thread.status === "waiting") return { label: "Needs you", tone: "amber" };
  switch (thread.status) {
    case "starting":
      return { label: "Starting", tone: "neutral" };
    case "idle":
      return { label: "Ready", tone: "green" };
    case "working":
      return { label: "Working", tone: "blue" };
    case "stopped":
      return { label: "Stopped", tone: "neutral" };
    case "failed":
      return { label: "Failed", tone: "red" };
  }
}

export function terminalStatus(terminal: Pick<TerminalProjection, "status">): StatusView {
  switch (terminal.status) {
    case "starting":
      return { label: "Starting", tone: "neutral" };
    case "running":
      return { label: "Running", tone: "green" };
    case "exited":
      return { label: "Exited", tone: "neutral" };
    case "failed":
      return { label: "Failed", tone: "red" };
  }
}

export type AgentRow = {
  thread: ThreadProjection;
  name: string;
  status: StatusView;
  openRequests: number;
  /** The newest line of the conversation, for the list preview. */
  preview: string | undefined;
};

export type WorktreeSection = {
  worktree: WorktreeProjection;
  agents: AgentRow[];
  shells: TerminalProjection[];
};

export type ProjectSection = { project: ProjectProjection; worktrees: WorktreeSection[]; stoppedAgents: number };

const statusOrder: Record<Tone, number> = { amber: 0, blue: 1, red: 2, green: 3, neutral: 4 };

function lastLine(text: string): string | undefined {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const line = lines.at(-1);
  if (!line) return undefined;
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}

export function agentRow(projection: RuntimeProjection, thread: ThreadProjection): AgentRow {
  const openRequests = (projection.requests ?? []).filter((request) => request.threadId === thread.threadId).length;
  const messages = projection.messages ?? [];
  let preview: string | undefined;
  for (let index = messages.length - 1; index >= 0 && preview === undefined; index -= 1) {
    const message = messages[index];
    if (message?.threadId === thread.threadId && message.role !== "system") preview = lastLine(message.text);
  }
  return {
    thread,
    name: agentTitle(thread, projection.providers),
    status: threadStatus(thread, openRequests),
    openRequests,
    preview,
  };
}

/**
 * Projects with their live worktrees, agents, and shells. Stopped agents are counted, not listed:
 * a long-running desktop collects many and the phone screen is small.
 */
export function projectSections(projection: RuntimeProjection): ProjectSection[] {
  return projection.projects
    .map((project) => {
      let stoppedAgents = 0;
      const worktrees = projection.worktrees
        .filter((worktree) => worktree.projectId === project.projectId && worktree.status !== "cancelled")
        .map((worktree) => {
          const threads = projection.threads.filter((thread) => thread.worktreeId === worktree.worktreeId);
          stoppedAgents += threads.filter((thread) => thread.status === "stopped").length;
          const agents = threads
            .filter((thread) => thread.status !== "stopped")
            .map((thread) => agentRow(projection, thread))
            .sort((left, right) => statusOrder[left.status.tone] - statusOrder[right.status.tone]);
          const shells = projection.terminals.filter(
            (terminal) =>
              terminal.worktreeId === worktree.worktreeId &&
              terminal.kind !== "agent" &&
              (terminal.status === "running" || terminal.status === "starting"),
          );
          return { worktree, agents, shells };
        })
        .sort((left, right) => right.agents.length - left.agents.length);
      return { project, worktrees, stoppedAgents };
    })
    .sort((left, right) => left.project.name.localeCompare(right.project.name));
}

export type PendingRequest = { request: ThreadRequestProjection; thread: ThreadProjection; name: string };

export function pendingRequests(projection: RuntimeProjection | undefined, threadId?: string): PendingRequest[] {
  if (!projection) return [];
  return (projection.requests ?? []).flatMap((request) => {
    if (threadId !== undefined && request.threadId !== threadId) return [];
    const thread = projection.threads.find((candidate) => candidate.threadId === request.threadId);
    return thread ? [{ request, thread, name: agentTitle(thread, projection.providers) }] : [];
  });
}

export function queuedMessages(projection: RuntimeProjection, threadId: string): ThreadQueuedMessage[] {
  return (projection.queuedMessages ?? []).filter((queued) => queued.threadId === threadId);
}

/** The tool call the agent is running now, shown under the conversation while it works. */
export function currentActivity(
  projection: RuntimeProjection,
  thread: ThreadProjection,
): ThreadActivityProjection | undefined {
  if (thread.status !== "working") return undefined;
  const activities = projection.activities ?? [];
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity?.threadId !== thread.threadId) continue;
    if (thread.activeTurnId && activity.turnId && activity.turnId !== thread.activeTurnId) return undefined;
    return activity.status === "running" ? activity : undefined;
  }
  return undefined;
}

export function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
  return normalize(left) === normalize(right);
}

function isCheckout(worktree: WorktreeProjection, project: ProjectProjection): boolean {
  return worktree.kind === "checkout" || samePath(worktree.path, project.path);
}

/** The project's own working copy, if the desktop already lists it. */
export function checkoutWorktree(
  projection: Pick<RuntimeProjection, "worktrees">,
  project: ProjectProjection,
): WorktreeProjection | undefined {
  return projection.worktrees.find(
    (worktree) =>
      worktree.projectId === project.projectId && worktree.status !== "cancelled" && isCheckout(worktree, project),
  );
}

/** Worktrees an agent can join, not counting the project's own checkout. */
export function readyWorktrees(projection: RuntimeProjection, project: ProjectProjection): WorktreeProjection[] {
  return projection.worktrees.filter(
    (worktree) =>
      worktree.projectId === project.projectId && worktree.status === "ready" && !isCheckout(worktree, project),
  );
}

const branchStems: Record<string, string> = { "claude-code": "claude", "cursor-agent": "cursor" };

export function branchSuffix(): string {
  return Math.random().toString(36).slice(2, 6).padEnd(4, "0");
}

/** The desktop's default branch template, `{agent}-{random}`. */
export function suggestedBranch(provider: string | undefined, random: () => string = branchSuffix): string {
  const stem = provider ? (branchStems[provider] ?? provider) : "agent";
  return `${safeBranchName(stem) || "agent"}-${random()}`;
}

export function installedProviders(
  projection: RuntimeProjection | undefined,
): Extract<ProviderDiscovery, { status: "found" }>[] {
  return (projection?.providers ?? []).filter(
    (provider): provider is Extract<ProviderDiscovery, { status: "found" }> => provider.status === "found",
  );
}

export function safeBranchName(branch: string): string {
  return branch
    .trim()
    .replace(/[^a-zA-Z0-9._/-]/gu, "-")
    .replace(/^[-/]+|[-/]+$/gu, "");
}

/** The same folder layout the desktop uses, which the gateway also requires. */
export function newWorktreePath(projectPath: string, branch: string): string {
  return `${worktreeRoot(projectPath)}/${safeBranchName(branch).replace(/[\\/]/gu, "-")}`;
}

export function newWorktreeCommand(project: ProjectProjection, branch: string, worktreeId: string) {
  return {
    type: "worktree.create",
    worktreeId,
    projectId: project.projectId,
    path: newWorktreePath(project.path, branch),
    workspaceRoot: worktreeRoot(project.path),
    branch: safeBranchName(branch),
  } as const;
}

export function importCheckoutCommand(project: ProjectProjection, worktreeId: string) {
  return {
    type: "worktree.import",
    worktreeId,
    projectId: project.projectId,
    path: project.path,
    // The runtime replaces this with the checked-out branch once it reads the repository.
    branch: "HEAD",
    kind: "checkout",
  } as const;
}

export function startAgentCommand(input: {
  threads: readonly ThreadProjection[];
  worktree: { worktreeId: string; path: string };
  provider: string;
  model: string | undefined;
  permissionMode: PermissionMode;
  threadId: string;
  sessionId: string;
}) {
  return {
    type: "thread.start",
    threadId: input.threadId,
    worktreeId: input.worktree.worktreeId,
    provider: input.provider,
    cwd: input.worktree.path,
    sessionId: input.sessionId,
    permissionMode: input.permissionMode,
    ...(input.model ? { model: input.model } : {}),
    // Picking a worktree that already has an agent is a deliberate choice to share it.
    ...(worktreeHasLiveThread(input.threads, input.worktree.worktreeId) ? { shareWorktree: true } : {}),
  } as const;
}

/** The phone cannot see which system the desktop runs, so the worktree path tells. */
export function shellForPath(path: string): string {
  return /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith("\\\\") ? "powershell.exe" : "/bin/bash";
}

export function newShellCommand(worktree: { worktreeId: string; path: string }, terminalId: string) {
  return {
    type: "terminal.create",
    terminalId,
    worktreeId: worktree.worktreeId,
    cwd: worktree.path,
    shell: shellForPath(worktree.path),
    title: "Phone shell",
    cols: 100,
    rows: 32,
  } as const;
}
