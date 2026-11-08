import { METRO_ENV_KEYS, metroPortFor, type PortWorktree, type RuntimeProjection } from "@zli-v2/contracts";

/**
 * ZLI_METRO_PORT and RCT_METRO_PORT for a worktree's terminals and agents, so each worktree's Metro gets its own
 * port. The project's own checkout keeps Metro's default and gets nothing, as does a worktree ZLI does not know.
 */
export function metroEnv(worktreeId: string | undefined, worktrees: readonly PortWorktree[]): Record<string, string> {
  if (!worktreeId) return {};
  const worktree = worktrees.find((entry) => entry.worktreeId === worktreeId);
  if (!worktree || worktree.kind === "checkout" || worktree.status === "cancelled") return {};
  const port = String(metroPortFor(worktreeId, worktrees));
  return Object.fromEntries(METRO_ENV_KEYS.map((key) => [key, port]));
}

/** metroEnv against the runtime's current worktrees. A failed read adds nothing rather than blocking a launch. */
export async function projectionMetroEnv(
  engine: { projection(): Promise<Pick<RuntimeProjection, "worktrees">> },
  worktreeId: string | undefined,
): Promise<Record<string, string>> {
  if (!worktreeId) return {};
  try {
    return metroEnv(worktreeId, (await engine.projection()).worktrees);
  } catch {
    return {};
  }
}
