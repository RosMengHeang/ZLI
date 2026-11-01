import type { RpcResponse, RuntimeProjection, ThreadProjection } from "@zli-v2/contracts";

import { makeCommandId } from "../../runtime/commandId.js";

const TAKES_INPUT: ReadonlySet<ThreadProjection["status"]> = new Set(["idle", "starting", "working", "waiting"]);

/** The worktree's most recently active chat agent that can take a message, if any. */
export function worktreeChatAgent(
  projection: Pick<RuntimeProjection, "threads"> | undefined,
  worktreeId: string,
): ThreadProjection | undefined {
  const stamp = (thread: ThreadProjection) => Date.parse(thread.updatedAt ?? thread.createdAt ?? "") || 0;
  return projection?.threads
    .filter((thread) => thread.worktreeId === worktreeId && TAKES_INPUT.has(thread.status))
    .sort((left, right) => stamp(right) - stamp(left))[0];
}

/**
 * Sends text to the worktree's chat agent: as its next turn when it is idle, or queued behind the turn it is on.
 * Returns false when the worktree has no chat agent. Throws with the runtime's reason when it refuses.
 */
export async function sendToWorktreeAgent(
  runtime: {
    projection: Pick<RuntimeProjection, "threads"> | undefined;
    dispatch(request: unknown): Promise<RpcResponse | undefined>;
  },
  worktreeId: string,
  text: string,
): Promise<boolean> {
  const thread = worktreeChatAgent(runtime.projection, worktreeId);
  if (!thread) return false;
  const command =
    thread.status === "idle"
      ? { type: "thread.send", threadId: thread.threadId, text }
      : { type: "thread.queue", threadId: thread.threadId, queueId: makeCommandId(), text };
  const response = await runtime.dispatch({ protocolVersion: 1, commandId: makeCommandId(), command });
  if (response?.accepted === false) throw new Error(response.error.message);
  if (!response) throw new Error("ZLI's runtime is not connected.");
  return true;
}
