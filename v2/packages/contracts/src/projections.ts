import { z } from "zod";
import { BrowserTabProjection } from "./browser.js";
import { EnvironmentId, ProjectId, ThreadId, WorktreeId } from "./ids.js";
import { LegacyImportProjection } from "./import.js";
import { ProviderDiscovery, ThreadMessageProjection, ThreadProjection, ThreadRequestProjection } from "./provider.js";
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
  terminals: z.array(TerminalProjection),
  browserTabs: z.array(BrowserTabProjection),
  reviews: z.array(ReviewProjection).optional(),
  diagnostics: DiagnosticsProjection.optional(),
  legacyImport: LegacyImportProjection.optional(),
  attention: z.array(AttentionProjection),
  lastSequence: z.number().int().nonnegative(),
});
export type RuntimeProjection = z.infer<typeof RuntimeProjection>;

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
