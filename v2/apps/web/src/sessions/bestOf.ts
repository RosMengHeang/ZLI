import { safeBranchName } from "./launch.js";

/** Most agents one best-of run starts side by side. */
export const MAX_RUNS = 4;

/** Agents started together on the same task, each in its own worktree, so one can be kept. */
export type RunGroup = {
  groupId: string;
  /** The branch the runs were named after, such as `fix-login` for `fix-login-1` and `fix-login-2`. */
  label: string;
  sessionIds: string[];
};

/** Branch names for `count` runs: the branch itself for one run, `<branch>-1` through `<branch>-N` for more. */
export function runBranches(branch: string, count: number): string[] {
  const safe = safeBranchName(branch);
  if (!safe) return [];
  const runs = Math.max(1, Math.min(MAX_RUNS, Math.floor(count)));
  if (runs === 1) return [safe];
  return Array.from({ length: runs }, (_, index) => `${safe}-${index + 1}`);
}

/** Still being made: removing it now would race the creation, so it is cancelled instead. */
export function worktreeInProgress(status: string): boolean {
  return status === "queued" || status === "creating" || status === "fetching" || status === "bootstrapping";
}

export type RunPosition = { group: RunGroup; index: number; count: number };

export function runPosition(groups: readonly RunGroup[], sessionId: string): RunPosition | undefined {
  for (const group of groups) {
    const index = group.sessionIds.indexOf(sessionId);
    if (index >= 0) return { group, index: index + 1, count: group.sessionIds.length };
  }
  return undefined;
}

/** Drops a session from its group. A group left with one run is no longer a comparison, so it goes too. */
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
        typeof entry.label === "string" &&
        Array.isArray(entry.sessionIds) &&
        entry.sessionIds.length > 1 &&
        entry.sessionIds.every((id: unknown) => typeof id === "string"),
    )
    .slice(-50)
    .map((entry) => ({
      groupId: entry.groupId,
      label: entry.label,
      sessionIds: entry.sessionIds.slice(0, MAX_RUNS),
    }));
}
