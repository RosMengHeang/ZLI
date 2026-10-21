import type { RuntimeProjection, WorktreeProjection, WorktreeSetupProjection } from "@zli-v2/contracts";

export function worktreeSetup(
  projection: Pick<RuntimeProjection, "worktreeSetups"> | undefined,
  worktreeId: string | undefined,
): WorktreeSetupProjection | undefined {
  if (!worktreeId) return undefined;
  return projection?.worktreeSetups?.find((setup) => setup.worktreeId === worktreeId);
}

/** The oldest setup that needs the person's answer, skipping ones they put off. */
export function nextSetupApproval(
  projection: Pick<RuntimeProjection, "worktreeSetups"> | undefined,
  deferred: readonly string[],
): WorktreeSetupProjection | undefined {
  return projection?.worktreeSetups?.find(
    (setup) => setup.status === "waiting" && !deferred.includes(`${setup.worktreeId}:${setup.commandsHash}`),
  );
}

export function setupDeferKey(setup: WorktreeSetupProjection): string {
  return `${setup.worktreeId}:${setup.commandsHash}`;
}

export type SetupBadge = { label: string; tone: "progress" | "attention" | "danger" | "muted" };

/** What the sidebar shows instead of the plain worktree status while setup matters. */
export function setupBadge(
  worktree: Pick<WorktreeProjection, "status">,
  setup: WorktreeSetupProjection | undefined,
): SetupBadge | undefined {
  if (!setup) return undefined;
  switch (setup.status) {
    case "copying":
    case "running":
      return worktree.status === "bootstrapping" ? { label: "Setting up", tone: "progress" } : undefined;
    case "waiting":
      return worktree.status === "bootstrapping" ? { label: "Needs approval", tone: "attention" } : undefined;
    case "failed":
      return worktree.status === "ready" ? { label: "Setup failed", tone: "danger" } : undefined;
    case "invalid":
      return worktree.status === "ready" ? { label: "zli.json error", tone: "danger" } : undefined;
    case "skipped":
      return worktree.status === "ready" ? { label: "Setup skipped", tone: "muted" } : undefined;
    case "succeeded":
      return undefined;
  }
}

/** One line about setup progress, used while an agent waits for its worktree. */
export function setupProgress(setup: WorktreeSetupProjection): string {
  switch (setup.status) {
    case "copying":
      return "Copying files from the main checkout.";
    case "waiting":
      return "Waiting for you to approve the setup commands.";
    case "running": {
      const index = setup.commandIndex ?? 0;
      const command = setup.commands[index] ?? "";
      return setup.commands.length > 1
        ? `Running setup command ${index + 1} of ${setup.commands.length}: ${command}`
        : `Running setup: ${command}`;
    }
    case "failed":
      return setup.errorMessage ?? "Setup failed.";
    case "invalid":
      return setup.errorMessage ?? "zli.json could not be read.";
    case "skipped":
      return setup.errorMessage ?? "Setup was skipped.";
    case "succeeded":
      return "Setup finished.";
  }
}
