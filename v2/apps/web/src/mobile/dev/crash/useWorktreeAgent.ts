import type { RuntimeProjection } from "@zli-v2/contracts";
import { useCallback } from "react";

import { useRuntime, useRuntimeSelector } from "../../../runtime/RuntimeProvider.js";
import { sendToWorktreeAgent, worktreeChatAgent } from "../sendToAgent.js";

const NO_THREADS: RuntimeProjection["threads"] = [];
const selectThreads = (projection: RuntimeProjection | undefined) => projection?.threads ?? NO_THREADS;
const selectWorktrees = (projection: RuntimeProjection | undefined) => projection?.worktrees;

/** The worktree's chat agent for Send to agent: whether there is one, its worktree's name, and send. */
export function useWorktreeAgent(worktreeId: string | undefined): {
  available: boolean;
  /** The branch, as in "Sent to the agent in feat-login". */
  name: string;
  send(text: string): Promise<boolean>;
} {
  const { dispatch } = useRuntime();
  const threads = useRuntimeSelector(selectThreads);
  const worktree = useRuntimeSelector(selectWorktrees)?.find((entry) => entry.worktreeId === worktreeId);
  const available = worktreeId !== undefined && worktreeChatAgent({ threads }, worktreeId) !== undefined;
  const name =
    worktree?.branch ?? worktree?.path.replaceAll("\\", "/").split("/").filter(Boolean).pop() ?? "this worktree";
  const send = useCallback(
    async (text: string) =>
      worktreeId ? sendToWorktreeAgent({ projection: { threads }, dispatch }, worktreeId, text) : false,
    [dispatch, threads, worktreeId],
  );
  return { available, name, send };
}

/** Copies text, and says so through the panel's notice or error. */
export function copyText(
  text: string,
  done: string,
  onNotice: (message: string) => void,
  onError: (message: string) => void,
) {
  const failed = "ZLI could not copy this. Select the text and copy it instead.";
  if (!navigator.clipboard) {
    onError(failed);
    return;
  }
  navigator.clipboard.writeText(text).then(
    () => onNotice(done),
    () => onError(failed),
  );
}
