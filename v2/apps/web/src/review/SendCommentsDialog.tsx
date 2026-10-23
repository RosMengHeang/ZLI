import type { WorktreeProjection } from "@zli-v2/contracts";
import { useMemo } from "react";

import type { SessionMode } from "../sessions/sessions.js";
import { formatCommentsMessage, type ReviewComment, removeReviewComments } from "./reviewComments.js";
import { SendToAgentDialog } from "./SendToAgentDialog.js";

export function SendCommentsDialog({
  worktree,
  comments,
  onClose,
  onShowAgent,
}: {
  worktree: WorktreeProjection;
  comments: readonly ReviewComment[];
  onClose(): void;
  onShowAgent?: ((sessionId: string, mode: SessionMode) => void) | undefined;
}) {
  const message = useMemo(() => formatCommentsMessage(comments, worktree.branch), [comments, worktree.branch]);
  const count = comments.length;
  return (
    <SendToAgentDialog
      label="Send comments"
      title={`Send ${count} comment${count === 1 ? "" : "s"}`}
      worktree={worktree}
      message={message}
      noAgentMessage={`No agent is running in ${worktree.branch}. Start one with New agent, then send the comments. They stay here until then.`}
      onSent={() => removeReviewComments(comments.map((comment) => comment.id))}
      onClose={onClose}
      onShowAgent={onShowAgent}
    />
  );
}
