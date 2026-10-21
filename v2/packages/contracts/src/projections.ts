import { z } from "zod";
import { BrowserTabProjection } from "./browser.js";
import { DevServerProjection } from "./devServers.js";
import { EnvironmentId, ProjectId, ThreadId, WorktreeId } from "./ids.js";
import { LegacyImportProjection } from "./import.js";
import { SetupTrustProjection, WorktreeSetupProjection } from "./projectConfig.js";
import {
  ProviderDiscovery,
  ThreadActivityProjection,
  ThreadMessageProjection,
  ThreadProjection,
  ThreadRequestProjection,
} from "./provider.js";
import { ReviewProjection } from "./review.js";
import { TerminalProjection } from "./terminal.js";

export const EnvironmentCapabilities = z.object({
  worktrees: z.boolean().optional(),
  terminals: z.boolean().optional(),
  browser: z.boolean().optional(),
  structuredProviders: z.boolean().optional(),
  eventReplay: z.boolean().optional(),
});
export type EnvironmentCapabilities = z.infer<typeof EnvironmentCapabilities>;

export const EnvironmentDescriptor = z.object({
  environmentId: EnvironmentId,
  label: z.string().min(1),
  protocolVersion: z.literal(1),
  capabilities: EnvironmentCapabilities,
});
export type EnvironmentDescriptor = z.infer<typeof EnvironmentDescriptor>;

export const ProjectProjection = z.object({
  projectId: ProjectId,
  path: z.string().min(1),
  name: z.string().min(1),
});
export type ProjectProjection = z.infer<typeof ProjectProjection>;

export const WorktreeProjection = z.object({
  worktreeId: WorktreeId,
  projectId: ProjectId,
  path: z.string().min(1),
  branch: z.string().min(1),
  status: z.enum(["queued", "fetching", "creating", "bootstrapping", "ready", "failed", "cancelling", "cancelled"]),
  errorMessage: z.string().min(1).optional(),
  /** "checkout" is the project's own working copy. Removing it only forgets it; files stay on disk. */
  kind: z.enum(["worktree", "checkout"]).optional(),
});
export type WorktreeProjection = z.infer<typeof WorktreeProjection>;

/** One checkout on the shared project card. Status is included; error text is not. */
export const SharedProjectWorktree = z.object({
  worktreeId: WorktreeId,
  path: z.string().min(1),
  branch: z.string().min(1),
  status: WorktreeProjection.shape.status,
});
export type SharedProjectWorktree = z.infer<typeof SharedProjectWorktree>;

/** One thread on the shared project card: id, status, and provider. No transcript. */
export const SharedProjectThread = z.object({
  threadId: ThreadId,
  worktreeId: WorktreeId,
  provider: z.string().min(1),
  status: ThreadProjection.shape.status,
});
export type SharedProjectThread = z.infer<typeof SharedProjectThread>;

/**
 * Read-only context for a single project. Repo root, that project's worktrees,
 * and that project's threads. Message text stays on the thread transcript.
 */
export const SharedProjectContext = z.object({
  projectId: ProjectId,
  repoRoot: z.string().min(1),
  worktrees: z.array(SharedProjectWorktree),
  threads: z.array(SharedProjectThread),
});
export type SharedProjectContext = z.infer<typeof SharedProjectContext>;

export const AttentionProjection = z.object({
  id: z.string().min(1),
  kind: z.enum(["approval", "user-input", "failure", "conflict"]),
  title: z.string().min(1),
});
export type AttentionProjection = z.infer<typeof AttentionProjection>;

export const SupportBundleProjection = z.object({
  path: z.string().min(1),
  bytes: z.number().int().positive(),
  entries: z.array(z.string().min(1)),
  createdAt: z.string().datetime({ offset: true }),
});
export type SupportBundleProjection = z.infer<typeof SupportBundleProjection>;

export const DiagnosticsProjection = z.object({
  lastBundle: SupportBundleProjection.optional(),
  lastError: z.string().min(1).optional(),
});
export type DiagnosticsProjection = z.infer<typeof DiagnosticsProjection>;

export const RuntimeProjection = z.object({
  environment: EnvironmentDescriptor,
  projects: z.array(ProjectProjection),
  projectContexts: z.array(SharedProjectContext).optional(),
  worktrees: z.array(WorktreeProjection),
  threads: z.array(ThreadProjection),
  providers: z.array(ProviderDiscovery).optional(),
  messages: z.array(ThreadMessageProjection).optional(),
  requests: z.array(ThreadRequestProjection).optional(),
  activities: z.array(ThreadActivityProjection).optional(),
  terminals: z.array(TerminalProjection),
  browserTabs: z.array(BrowserTabProjection),
  devServers: z.array(DevServerProjection).optional(),
  reviews: z.array(ReviewProjection).optional(),
  diagnostics: DiagnosticsProjection.optional(),
  legacyImport: LegacyImportProjection.optional(),
  attention: z.array(AttentionProjection),
  lastSequence: z.number().int().nonnegative(),
  worktreeSetups: z.array(WorktreeSetupProjection).optional(),
  setupTrust: z.array(SetupTrustProjection).optional(),
});
export type RuntimeProjection = z.infer<typeof RuntimeProjection>;

const MAX_PROJECTED_MESSAGES = 2_000;
const MAX_PROJECTED_ACTIVITIES = 4_000;

/** Drops a deleted session's terminals and threads, and everything recorded for those threads. */
export function removeSession(
  projection: RuntimeProjection,
  terminalIds: readonly string[],
  threadIds: readonly string[],
): RuntimeProjection {
  const terminals = new Set(terminalIds);
  const threads = new Set(threadIds);
  const requests = projection.requests ?? [];
  const removedRequests = new Set(
    requests.filter((request) => threads.has(request.threadId)).map((request) => `thread-request:${request.requestId}`),
  );
  return {
    ...projection,
    terminals: projection.terminals.filter((terminal) => !terminals.has(terminal.terminalId)),
    threads: projection.threads.filter((thread) => !threads.has(thread.threadId)),
    ...(projection.messages
      ? { messages: projection.messages.filter((message) => !threads.has(message.threadId)) }
      : {}),
    ...(projection.activities
      ? { activities: projection.activities.filter((activity) => !threads.has(activity.threadId)) }
      : {}),
    ...(projection.requests ? { requests: requests.filter((request) => !threads.has(request.threadId)) } : {}),
    attention: projection.attention.filter((item) => !removedRequests.has(item.id)),
  };
}

/** Streamed assistant text for one turn extends that turn's bubble instead of adding a new one. */
export function appendThreadMessage(
  messages: readonly ThreadMessageProjection[],
  message: ThreadMessageProjection,
): ThreadMessageProjection[] {
  if (message.role === "assistant" && message.turnId) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = messages[index];
      if (!candidate || candidate.threadId !== message.threadId) continue;
      if (candidate.role === "assistant" && candidate.turnId === message.turnId) {
        const merged = { ...candidate, text: candidate.text + message.text };
        return [...messages.slice(0, index), merged, ...messages.slice(index + 1)];
      }
      break;
    }
  }
  return [...messages.filter((candidate) => candidate.messageId !== message.messageId), message].slice(
    -MAX_PROJECTED_MESSAGES,
  );
}

/** A later update for the same tool call replaces it in place so the work log keeps its order. */
export function upsertThreadActivity(
  activities: readonly ThreadActivityProjection[],
  activity: ThreadActivityProjection,
): ThreadActivityProjection[] {
  const index = activities.findIndex((candidate) => candidate.activityId === activity.activityId);
  if (index === -1) return [...activities, activity].slice(-MAX_PROJECTED_ACTIVITIES);
  const previous = activities[index];
  const merged: ThreadActivityProjection = {
    ...previous,
    ...activity,
    ...(activity.files || previous?.files ? { files: activity.files ?? previous?.files } : {}),
  };
  return [...activities.slice(0, index), merged, ...activities.slice(index + 1)];
}

const retiredWorktreeStatuses = new Set<WorktreeProjection["status"]>(["cancelled"]);
const closedThreadStatuses = new Set<ThreadProjection["status"]>(["stopped"]);

/**
 * Statuses that still hold a worktree for a new bind.
 * Stopped and failed threads leave the worktree free.
 * Threads already sharing a worktree stay where they are; only a new start is checked.
 */
const occupyingThreadStatuses = new Set<ThreadProjection["status"]>(["starting", "idle", "working", "waiting"]);

export function threadOccupiesWorktree(status: ThreadProjection["status"]): boolean {
  return occupyingThreadStatuses.has(status);
}

export function worktreeHasLiveThread(
  threads: readonly { worktreeId: string; status: ThreadProjection["status"] }[],
  worktreeId: string,
): boolean {
  return threads.some((thread) => thread.worktreeId === worktreeId && threadOccupiesWorktree(thread.status));
}

/**
 * Project the live card from projects, worktrees, and threads already in the runtime.
 * Cancelled checkouts and stopped threads drop off. Transcripts are never copied.
 */
export function deriveSharedProjectContexts(state: {
  projects: readonly ProjectProjection[];
  worktrees: readonly WorktreeProjection[];
  threads: readonly ThreadProjection[];
}): SharedProjectContext[] {
  const worktreesByProject = new Map<ProjectId, SharedProjectWorktree[]>();
  const projectIdByWorktree = new Map<WorktreeId, ProjectId>();
  for (const worktree of state.worktrees) {
    projectIdByWorktree.set(worktree.worktreeId, worktree.projectId);
    if (retiredWorktreeStatuses.has(worktree.status)) continue;
    const entries = worktreesByProject.get(worktree.projectId) ?? [];
    entries.push({
      worktreeId: worktree.worktreeId,
      path: worktree.path,
      branch: worktree.branch,
      status: worktree.status,
    });
    worktreesByProject.set(worktree.projectId, entries);
  }

  const threadsByProject = new Map<ProjectId, SharedProjectThread[]>();
  for (const thread of state.threads) {
    if (closedThreadStatuses.has(thread.status)) continue;
    const projectId = projectIdByWorktree.get(thread.worktreeId);
    if (projectId === undefined) continue;
    const entries = threadsByProject.get(projectId) ?? [];
    entries.push({
      threadId: thread.threadId,
      worktreeId: thread.worktreeId,
      provider: thread.provider,
      status: thread.status,
    });
    threadsByProject.set(projectId, entries);
  }

  return state.projects.map((project) => ({
    projectId: project.projectId,
    repoRoot: project.path,
    worktrees: worktreesByProject.get(project.projectId) ?? [],
    threads: threadsByProject.get(project.projectId) ?? [],
  }));
}
