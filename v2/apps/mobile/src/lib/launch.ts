import type { PermissionMode, ProjectProjection, WorktreeProjection } from "@zli-v2/contracts";

import type { LinkSnapshot, RemoteLink } from "./link.js";
import { newWorktreeCommand, safeBranchName, startAgentCommand } from "./views.js";

type CommandLink = Pick<RemoteLink, "command" | "getSnapshot" | "subscribe">;

export type CommandOutcome = { ok: true; result: unknown } | { ok: false; error: string };

/** Sends one runtime command and turns a refusal or a dropped connection into a message. */
export async function sendCommand(
  link: Pick<RemoteLink, "command">,
  command: Record<string, unknown> & { type: string },
  fallback: string,
): Promise<CommandOutcome> {
  try {
    const response = await link.command(command);
    return response.accepted ? { ok: true, result: response.result } : { ok: false, error: response.error.message };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error && cause.message ? cause.message : fallback };
  }
}

export type Placement = { kind: "new"; branch: string } | { kind: "existing"; worktreeId: string };

export type LaunchInput = {
  project: ProjectProjection;
  placement: Placement;
  provider: string;
  model: string | undefined;
  permissionMode: PermissionMode;
};

export type LaunchStep = "creating-worktree" | "starting-agent";

/** Resolves once the worktree is ready, or with the reason it never will be. */
export function waitForWorktree(
  link: Pick<RemoteLink, "getSnapshot" | "subscribe">,
  worktreeId: string,
  signal?: AbortSignal,
): Promise<{ worktree: WorktreeProjection } | { error: string }> {
  return new Promise((resolve) => {
    let stop: (() => void) | undefined;
    const check = (snapshot: LinkSnapshot) => {
      const worktree = snapshot.projection?.worktrees.find((candidate) => candidate.worktreeId === worktreeId);
      if (worktree?.status === "ready") return finish({ worktree });
      if (worktree?.status === "failed")
        return finish({ error: worktree.errorMessage ?? "The worktree could not be created." });
      if (worktree?.status === "cancelled" || worktree?.status === "cancelling") {
        return finish({ error: "The worktree was cancelled on the desktop." });
      }
    };
    const finish = (outcome: { worktree: WorktreeProjection } | { error: string }) => {
      stop?.();
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = () => finish({ error: "Stopped waiting for the worktree." });
    signal?.addEventListener("abort", onAbort);
    stop = link.subscribe(() => check(link.getSnapshot()));
    check(link.getSnapshot());
  });
}

/** Creates a worktree when asked, waits for it, then starts a chat agent in it. */
export async function launchAgent(
  link: CommandLink,
  input: LaunchInput,
  newId: () => string,
  onStep: (step: LaunchStep) => void,
  signal?: AbortSignal,
): Promise<{ threadId: string } | { error: string }> {
  let worktreeId: string;
  if (input.placement.kind === "new") {
    if (!safeBranchName(input.placement.branch)) return { error: "Choose a branch name for the new worktree." };
    onStep("creating-worktree");
    worktreeId = newId();
    const created = await sendCommand(
      link,
      newWorktreeCommand(input.project, input.placement.branch, worktreeId),
      "The worktree could not be created.",
    );
    if (!created.ok) return { error: created.error };
  } else {
    worktreeId = input.placement.worktreeId;
  }

  const ready = await waitForWorktree(link, worktreeId, signal);
  if ("error" in ready) return ready;

  onStep("starting-agent");
  const threadId = newId();
  const started = await sendCommand(
    link,
    startAgentCommand({
      threads: link.getSnapshot().projection?.threads ?? [],
      worktree: ready.worktree,
      provider: input.provider,
      model: input.model,
      permissionMode: input.permissionMode,
      threadId,
      sessionId: newId(),
    }),
    "The agent could not start.",
  );
  return started.ok ? { threadId } : { error: started.error };
}
