import { z } from "zod";
import { BrowserTabProjection } from "./browser.js";
import { ThreadCheckpoint } from "./checkpoints.js";
import { DevServerProjection } from "./devServers.js";
import { dropHuddleMembers, HuddlePost, HuddleProjection } from "./huddles.js";
import { EnvironmentId, ProjectId, ThreadId, WorktreeId } from "./ids.js";
import { LegacyImportProjection } from "./import.js";
import { SetupTrustProjection, WorktreeSetupProjection } from "./projectConfig.js";
import {
  MAX_REASONING_TEXT,
  ProviderDiscovery,
  ThreadActivityProjection,
  ThreadMessageProjection,
  ThreadProjection,
  ThreadQueuedMessage,
  ThreadRequestProjection,
  ThreadTurnProjection,
  ThreadUsageRecord,
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
  /** False when the folder is not a Git repository. Missing means it is one, or it has not been checked yet. */
  git: z.boolean().optional(),
  /** The person let agents work in this folder, so ZLI answers each agent CLI's own "trust this folder?" question. */
  agentsTrusted: z.boolean().optional(),
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
  /** The worktree's Metro port, pinned at creation so it never moves while the worktree exists. */
  metroPort: z.number().int().optional(),
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
  queuedMessages: z.array(ThreadQueuedMessage).optional(),
  usage: z.array(ThreadUsageRecord).optional(),
  checkpoints: z.array(ThreadCheckpoint).optional(),
  activities: z.array(ThreadActivityProjection).optional(),
  turns: z.array(ThreadTurnProjection).optional(),
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
  huddles: z.array(HuddleProjection).optional(),
  huddlePosts: z.array(HuddlePost).optional(),
});
export type RuntimeProjection = z.infer<typeof RuntimeProjection>;

/**
 * History is capped per chat, not across all of them: a shared cap let a busy chat push every older
 * chat's messages out of the projection.
 */
export const MAX_MESSAGES_PER_THREAD = 1_000;
export const MAX_ACTIVITIES_PER_THREAD = 2_000;
export const MAX_CHECKPOINTS_PER_THREAD = 200;
export const MAX_USAGE_PER_THREAD = 1_000;
export const MAX_TURNS_PER_THREAD = 1_000;

/** Drops the oldest entries of one thread beyond `max`, leaving every other thread's entries in place. */
export function trimThread<T extends { threadId: string }>(items: T[], threadId: string, max: number): T[] {
  let count = 0;
  for (const item of items) if (item.threadId === threadId) count += 1;
  let excess = count - max;
  if (excess <= 0) return items;
  return items.filter((item) => {
    if (excess > 0 && item.threadId === threadId) {
      excess -= 1;
      return false;
    }
    return true;
  });
}

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
    ...dropHuddleMembers(projection, [...terminalIds, ...threadIds]),
    terminals: projection.terminals.filter((terminal) => !terminals.has(terminal.terminalId)),
    threads: projection.threads.filter((thread) => !threads.has(thread.threadId)),
    ...(projection.messages
      ? { messages: projection.messages.filter((message) => !threads.has(message.threadId)) }
      : {}),
    ...(projection.activities
      ? { activities: projection.activities.filter((activity) => !threads.has(activity.threadId)) }
      : {}),
    ...(projection.turns ? { turns: projection.turns.filter((turn) => !threads.has(turn.threadId)) } : {}),
    ...(projection.requests ? { requests: requests.filter((request) => !threads.has(request.threadId)) } : {}),
    ...(projection.queuedMessages
      ? { queuedMessages: projection.queuedMessages.filter((queued) => !threads.has(queued.threadId)) }
      : {}),
    ...(projection.checkpoints
      ? { checkpoints: projection.checkpoints.filter((checkpoint) => !threads.has(checkpoint.threadId)) }
      : {}),
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
  return trimThread(
    [...messages.filter((candidate) => candidate.messageId !== message.messageId), message],
    message.threadId,
    MAX_MESSAGES_PER_THREAD,
  );
}

/** A message from another agent lands as-is; delivering the same message again replaces it. */
export function deliverAgentMessage(
  messages: readonly ThreadMessageProjection[],
  message: ThreadMessageProjection,
): ThreadMessageProjection[] {
  return trimThread(
    [...messages.filter((candidate) => candidate.messageId !== message.messageId), message],
    message.threadId,
    MAX_MESSAGES_PER_THREAD,
  );
}

export function appendCheckpoint(
  checkpoints: readonly ThreadCheckpoint[],
  checkpoint: ThreadCheckpoint,
): ThreadCheckpoint[] {
  return trimThread(
    [...checkpoints.filter((candidate) => candidate.checkpointId !== checkpoint.checkpointId), checkpoint],
    checkpoint.threadId,
    MAX_CHECKPOINTS_PER_THREAD,
  );
}

/** A turn reports usage as it goes; the latest report for a turn replaces the earlier one. */
export function upsertUsageRecord(
  records: readonly ThreadUsageRecord[],
  record: ThreadUsageRecord,
): ThreadUsageRecord[] {
  const index = records.findIndex((candidate) => candidate.usageId === record.usageId);
  if (index === -1) return trimThread([...records, record], record.threadId, MAX_USAGE_PER_THREAD);
  return [...records.slice(0, index), record, ...records.slice(index + 1)];
}

/**
 * A later update for the same tool call replaces it in place so the work log keeps its order.
 * `at` is when the event was recorded: the first update stamps startedAt and the first finished one
 * stamps completedAt. A reasoning step's text arrives in parts, so each update adds to it.
 */
export function upsertThreadActivity(
  activities: readonly ThreadActivityProjection[],
  activity: ThreadActivityProjection,
  at?: string,
): ThreadActivityProjection[] {
  const index = activities.findIndex((candidate) => candidate.activityId === activity.activityId);
  const previous = index === -1 ? undefined : activities[index];
  const startedAt = previous?.startedAt ?? activity.startedAt ?? at;
  const completedAt = activity.status === "running" ? undefined : (previous?.completedAt ?? activity.completedAt ?? at);
  const text = activity.kind === "reasoning" ? reasoningText(previous?.text, activity.text) : undefined;
  const truncated = previous?.truncated === true || activity.truncated === true || text?.truncated === true;
  const stamped: ThreadActivityProjection = {
    ...activity,
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(text?.value ? { text: text.value } : {}),
    ...(truncated ? { truncated } : {}),
  };
  if (!previous) return trimThread([...activities, stamped], activity.threadId, MAX_ACTIVITIES_PER_THREAD);
  const { completedAt: _previousCompletedAt, ...kept } = previous;
  const merged: ThreadActivityProjection = {
    ...(activity.status === "running" ? kept : previous),
    ...stamped,
    ...(activity.files || previous.files ? { files: activity.files ?? previous.files } : {}),
    // A call keeps its place in the reply when later updates report it again.
    ...(previous.textOffset !== undefined ? { textOffset: previous.textOffset } : {}),
  };
  return [...activities.slice(0, index), merged, ...activities.slice(index + 1)];
}

function reasoningText(
  previous: string | undefined,
  added: string | undefined,
): { value: string; truncated: boolean } | undefined {
  if (previous === undefined && added === undefined) return undefined;
  const joined = (previous ?? "") + (added ?? "");
  if (joined.length <= MAX_REASONING_TEXT) return { value: joined, truncated: false };
  return { value: joined.slice(0, MAX_REASONING_TEXT), truncated: true };
}

/**
 * Keeps each turn's start and end from the thread's status changes. Working on a new turn starts it;
 * idle, stopped, or failed ends the open turn the change names, or every open turn of the thread when
 * it names none. Turns are keyed by the agent's own turn id, the one messages and activities carry.
 */
export function recordTurnStatus(
  turns: readonly ThreadTurnProjection[],
  change: {
    threadId: ThreadId;
    status: ThreadProjection["status"];
    turnId?: string | undefined;
    providerTurnId?: string | undefined;
  },
  at: string,
): ThreadTurnProjection[] {
  const named = change.providerTurnId ?? change.turnId;
  if (change.status === "working") {
    if (!named) return [...turns];
    const known = turns.some((turn) => turn.threadId === change.threadId && turn.turnId === named);
    if (known) return [...turns];
    return trimThread(
      [...turns, { threadId: change.threadId, turnId: named, startedAt: at }],
      change.threadId,
      MAX_TURNS_PER_THREAD,
    );
  }
  const ended =
    change.status === "idle"
      ? "completed"
      : change.status === "failed"
        ? "failed"
        : change.status === "stopped"
          ? "stopped"
          : undefined;
  if (!ended) return [...turns];
  return turns.map((turn) =>
    turn.threadId === change.threadId && !turn.completedAt && (!named || turn.turnId === named)
      ? { ...turn, completedAt: at, status: ended }
      : turn,
  );
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
