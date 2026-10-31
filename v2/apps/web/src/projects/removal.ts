import type { ProjectProjection, RuntimeProjection } from "@zli-v2/contracts";

import { samePath } from "../sessions/launch.js";
import { deriveSessions, sessionStopCommands } from "../sessions/sessions.js";

export type ProjectStats = { agents: number; running: number; worktrees: number };

export function projectStats(projection: RuntimeProjection | undefined, project: ProjectProjection): ProjectStats {
  const worktrees = (projection?.worktrees ?? []).filter((worktree) => worktree.projectId === project.projectId);
  const worktreeIds = new Set<string>(worktrees.map((worktree) => worktree.worktreeId));
  const agents = projection ? deriveSessions(projection).filter((session) => worktreeIds.has(session.worktreeId)) : [];
  return {
    agents: agents.length,
    running: agents.filter((session) => sessionStopCommands(session).length > 0).length,
    worktrees: worktrees.filter((worktree) => worktree.kind !== "checkout" && !samePath(worktree.path, project.path))
      .length,
  };
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** What removing the project takes with it, so the confirmation can say so. */
export function removalDetail(stats: ProjectStats): string {
  const parts: string[] = [];
  if (stats.running > 0) parts.push(`${plural(stats.running, "running agent")} will be stopped.`);
  if (stats.agents === 1) parts.push("1 agent and its chat are deleted from ZLI.");
  if (stats.agents > 1) parts.push(`${stats.agents} agents and their chats are deleted from ZLI.`);
  parts.push(
    stats.worktrees > 0
      ? `The folder and its ${plural(stats.worktrees, "worktree")} stay on disk.`
      : "The folder and its files stay on disk.",
  );
  return parts.join(" ");
}
