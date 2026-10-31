import { randomUUID } from "node:crypto";

import type { RpcResponse, RuntimeProjection } from "@zli-v2/contracts";

import { BrowserControlError, type BrowserControlWorktree, normalizeWorktreePath } from "./BrowserControlActions.js";

export type ProjectCheckoutHost = {
  projection(): RuntimeProjection | undefined;
  command(request: { protocolVersion: 1; commandId: string; command: Record<string, unknown> }): Promise<RpcResponse>;
  readonly platform?: NodeJS.Platform;
  readonly newId?: () => string;
};

/**
 * Finds the registered project that contains `cwd` and returns its own checkout, adding it to the
 * workspace when it is missing. Folders without Git have no worktrees, so the checkout is the only
 * place their browser tabs can live.
 */
export function createProjectCheckout(
  host: ProjectCheckoutHost,
): (cwd: string) => Promise<BrowserControlWorktree | undefined> {
  const platform = host.platform ?? process.platform;
  const newId = host.newId ?? randomUUID;
  const pending = new Map<string, Promise<BrowserControlWorktree>>();

  const importCheckout = async (projectId: string, path: string): Promise<BrowserControlWorktree> => {
    const worktreeId = newId();
    let response: RpcResponse;
    try {
      response = await host.command({
        protocolVersion: 1,
        commandId: newId(),
        // The runtime replaces the branch with the checked-out one once it reads the folder.
        command: { type: "worktree.import", worktreeId, projectId, path, branch: "HEAD", kind: "checkout" },
      });
    } catch (cause) {
      throw new BrowserControlError(
        `ZLI's runtime did not answer: ${cause instanceof Error ? cause.message : String(cause)}`,
        503,
      );
    }
    if (!response.accepted) throw new BrowserControlError(response.error.message, 409);
    return { worktreeId, path, status: "ready" };
  };

  return async (cwd) => {
    const state = host.projection();
    if (!state) return undefined;
    const target = normalizeWorktreePath(cwd, platform);
    let project: (typeof state.projects)[number] | undefined;
    let depth = -1;
    for (const candidate of state.projects) {
      const root = normalizeWorktreePath(candidate.path, platform);
      if (target !== root && !target.startsWith(root.endsWith("/") ? root : `${root}/`)) continue;
      if (root.length > depth) {
        project = candidate;
        depth = root.length;
      }
    }
    if (!project) return undefined;
    const projectRoot = normalizeWorktreePath(project.path, platform);
    const existing = state.worktrees.find(
      (worktree) =>
        worktree.projectId === project.projectId &&
        worktree.status !== "cancelled" &&
        (worktree.kind === "checkout" || normalizeWorktreePath(worktree.path, platform) === projectRoot),
    );
    if (existing?.status === "ready") return existing;
    if (existing?.status === "failed")
      throw new BrowserControlError(
        `ZLI could not open ${project.name}. ${existing.errorMessage ?? "Retry it from the sidebar."}`.trim(),
        409,
      );
    if (existing) throw new BrowserControlError(`ZLI is still opening ${project.name}. Try again in a moment.`, 409);
    const inFlight = pending.get(project.projectId);
    if (inFlight) return inFlight;
    const created = importCheckout(project.projectId, project.path).finally(() => pending.delete(project.projectId));
    pending.set(project.projectId, created);
    return created;
  };
}
