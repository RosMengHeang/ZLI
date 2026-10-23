import type {
  RuntimeProjection,
  ThreadActivityProjection,
  ThreadCheckpoint,
  ThreadMessageProjection,
  WorktreeProjection,
} from "@zli-v2/contracts";

import { safeBranchName } from "./launch.js";
import type { AgentSession } from "./sessions.js";

export const MIN_RUNS = 2;
export const MAX_RUNS = 4;
export const DEFAULT_RUNS = 3;

/** The agent and model one run uses. No model means the agent's default. */
export type RunAgent = { provider: string; model?: string | undefined };

/** Where a run's files come from: another worktree as it is now, or the start of a saved turn. */
export type RunStart = { kind: "worktree"; worktreeId: string } | { kind: "checkpoint"; checkpointId: string };

/** Agents started together on the same message, each in its own worktree, so one can be kept. */
export type RunGroup = {
  groupId: string;
  /** The chat the runs started from. It stays as it was; the runs are listed under it. */
  sourceSessionId: string;
  /** The source chat's branch, which the run branches are named after. */
  label: string;
  prompt: string;
  sessionIds: string[];
  createdAt: string;
  /** Set once every run finished and the person was told. */
  notified?: boolean | undefined;
};

export type RunState = "running" | "done" | "failed";

export type PlannedRun = { index: number; branch: string; agent: RunAgent };

export function clampRuns(count: number): number {
  if (!Number.isFinite(count)) return DEFAULT_RUNS;
  return Math.max(MIN_RUNS, Math.min(MAX_RUNS, Math.floor(count)));
}

/** Grows or shrinks the list of run agents to `count`, filling new rows with `fill`. */
export function resizeRuns(runs: readonly RunAgent[], count: number, fill: RunAgent): RunAgent[] {
  const size = clampRuns(count);
  return Array.from({ length: size }, (_, index) => runs[index] ?? { ...fill });
}

/**
 * One worktree branch per run, `<branch>-run1` to `<branch>-runN`. When any of those names is taken,
 * every run moves to the next free prefix (`<branch>-2-run1`, and so on) so the set stays together.
 */
export function planRuns(branch: string, agents: readonly RunAgent[], taken: Iterable<string>): PlannedRun[] {
  const used = new Set(taken);
  const base = safeBranchName(branch === "HEAD" ? "best-of" : branch) || "best-of";
  const count = clampRuns(agents.length);
  const names = (prefix: string) => Array.from({ length: count }, (_, index) => `${prefix}-run${index + 1}`);
  let prefix = base;
  for (let attempt = 2; names(prefix).some((name) => used.has(name)); attempt += 1) prefix = `${base}-${attempt}`;
  return names(prefix).map((name, index) => ({
    index: index + 1,
    branch: name,
    agent: agents[index] ?? agents[0] ?? { provider: "codex" },
  }));
}

export type RunPosition = { group: RunGroup; index: number; count: number };

export function runPosition(groups: readonly RunGroup[], sessionId: string): RunPosition | undefined {
  for (const group of groups) {
    const index = group.sessionIds.indexOf(sessionId);
    if (index >= 0) return { group, index: index + 1, count: group.sessionIds.length };
  }
  return undefined;
}

/** Drops a run from its group. A group left with one run is no longer a comparison, so it goes too. */
export function withoutRun(groups: readonly RunGroup[], sessionId: string): RunGroup[] {
  return groups.flatMap((group) => {
    if (!group.sessionIds.includes(sessionId)) return [group];
    const sessionIds = group.sessionIds.filter((id) => id !== sessionId);
    return sessionIds.length > 1 ? [{ ...group, sessionIds }] : [];
  });
}

export function parseRunGroups(value: unknown): RunGroup[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry): entry is RunGroup =>
        typeof entry === "object" &&
        entry !== null &&
        typeof entry.groupId === "string" &&
        typeof entry.sourceSessionId === "string" &&
        typeof entry.label === "string" &&
        typeof entry.prompt === "string" &&
        typeof entry.createdAt === "string" &&
        Array.isArray(entry.sessionIds) &&
        entry.sessionIds.length > 1 &&
        entry.sessionIds.every((id: unknown) => typeof id === "string"),
    )
    .slice(-50)
    .map((entry) => ({
      groupId: entry.groupId,
      sourceSessionId: entry.sourceSessionId,
      label: entry.label,
      prompt: entry.prompt,
      sessionIds: entry.sessionIds.slice(0, MAX_RUNS),
      createdAt: entry.createdAt,
      ...(entry.notified === true ? { notified: true } : {}),
    }));
}

/** The agent answered the first message: a reply or an error came after it. */
export function runReplied(messages: readonly ThreadMessageProjection[] | undefined, threadId: string | undefined) {
  if (!threadId || !messages) return false;
  let asked = false;
  for (const message of messages) {
    if (message.threadId !== threadId) continue;
    if (message.role === "user") asked = true;
    else if (asked && (message.role === "assistant" || message.role === "system")) return true;
  }
  return false;
}

export function runState(session: AgentSession | undefined, replied: boolean): RunState {
  if (!session || session.status === "failed") return "failed";
  if (session.status === "ended") return replied ? "done" : "failed";
  if (session.status === "ready" && replied) return "done";
  return "running";
}

export const runStateLabel: Record<RunState, string> = { running: "Running", done: "Done", failed: "Failed" };

/** What deleting the other runs removes: each session, and its worktree and branch when only it uses them. */
export type RunCleanup = { session: AgentSession; worktree: WorktreeProjection | undefined };

export function keepRunCleanup(
  projection: Pick<RuntimeProjection, "worktrees">,
  sessions: readonly AgentSession[],
  group: RunGroup,
  keptSessionId: string,
): RunCleanup[] {
  const discarded = group.sessionIds.filter((sessionId) => sessionId !== keptSessionId);
  return discarded.flatMap((sessionId) => {
    const session = sessions.find((entry) => entry.sessionId === sessionId);
    if (!session) return [];
    const worktree = projection.worktrees.find(
      (entry) => entry.worktreeId === session.worktreeId && entry.kind !== "checkout",
    );
    // A worktree another kept chat still uses stays.
    const sharedWithKept = sessions.some(
      (other) => !discarded.includes(other.sessionId) && other.worktreeId === session.worktreeId,
    );
    return [{ session, worktree: sharedWithKept ? undefined : worktree }];
  });
}

export type RunChecks = { passed: number; failed: number };

export type RunSummary = {
  files: number;
  additions: number;
  deletions: number;
  /** Only when the agent reported a cost. */
  costUsd?: number | undefined;
  durationMs?: number | undefined;
  /** Test, lint, and type check commands the agent ran, when it ran any. */
  checks?: RunChecks | undefined;
};

const CHECK_COMMAND =
  /\b(test|tests|vitest|jest|mocha|pytest|unittest|rspec|lint|eslint|biome|ruff|clippy|tsc|typecheck|verify|check)\b/iu;

export function isCheckCommand(activity: Pick<ThreadActivityProjection, "kind" | "title">): boolean {
  return activity.kind === "command" && CHECK_COMMAND.test(activity.title);
}

/** The numbers the Compare view shows for one run. */
export function runSummary(
  projection: Pick<RuntimeProjection, "threads" | "checkpoints" | "usage" | "activities">,
  threadId: string | undefined,
): RunSummary {
  if (!threadId) return { files: 0, additions: 0, deletions: 0 };
  const checkpoints: ThreadCheckpoint[] = (projection.checkpoints ?? []).filter((entry) => entry.threadId === threadId);
  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;
  for (const checkpoint of checkpoints) {
    for (const file of checkpoint.files) files.add(file.path);
    additions += checkpoint.additions;
    deletions += checkpoint.deletions;
  }
  const costs = (projection.usage ?? [])
    .filter((record) => record.threadId === threadId && record.usage.costUsd !== undefined)
    .map((record) => record.usage.costUsd ?? 0);
  const thread = projection.threads.find((entry) => entry.threadId === threadId);
  const started = thread?.createdAt ? Date.parse(thread.createdAt) : Number.NaN;
  const ended = thread?.updatedAt ? Date.parse(thread.updatedAt) : Number.NaN;
  const checks = (projection.activities ?? []).filter(
    (activity) => activity.threadId === threadId && activity.status !== "running" && isCheckCommand(activity),
  );
  return {
    files: files.size,
    additions,
    deletions,
    ...(costs.length > 0 ? { costUsd: costs.reduce((sum, cost) => sum + cost, 0) } : {}),
    ...(Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? { durationMs: ended - started } : {}),
    ...(checks.length > 0
      ? {
          checks: {
            passed: checks.filter((activity) => activity.status === "completed").length,
            failed: checks.filter((activity) => activity.status === "failed").length,
          },
        }
      : {}),
  };
}

/**
 * Where "Try N ways" on a message starts from: the files as they were before the first turn at or
 * after that message that changed anything. When no later turn changed files, the worktree as it is
 * now already matches.
 */
export function forkPointAfter(
  index: number,
  placed: ReadonlyMap<number, readonly ThreadCheckpoint[]>,
): ThreadCheckpoint | undefined {
  let best: { at: number; checkpoint: ThreadCheckpoint } | undefined;
  for (const [at, checkpoints] of placed) {
    const first = checkpoints[0];
    if (at < index || !first) continue;
    if (!best || at < best.at) best = { at, checkpoint: first };
  }
  return best?.checkpoint;
}
