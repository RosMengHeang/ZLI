import type { WorktreeProjection } from "@zli-v2/contracts";
import { useState } from "react";

import type { SessionMode } from "../sessions/sessions.js";
import { Button } from "../ui/Button.js";
import { useReviewComments } from "./reviewComments.js";
import { SendCommentsDialog } from "./SendCommentsDialog.js";

/**
 * How many review notes on the worktree wait to be sent, from any panel that takes them, with a
 * way to send them all at once.
 */
export function ReviewNotesPill({
  worktree,
  onShowAgent,
}: {
  worktree: WorktreeProjection | undefined;
  onShowAgent?: ((sessionId: string, mode: SessionMode) => void) | undefined;
}) {
  const comments = useReviewComments(worktree?.worktreeId);
  const [sending, setSending] = useState(false);
  if (!worktree || (comments.length === 0 && !sending)) return null;
  const count = comments.length;
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        icon="message"
        className="review-notes-pill"
        aria-label={`${count} review note${count === 1 ? "" : "s"} not sent. Send to an agent`}
        tooltip="Send review notes to an agent"
        onClick={() => setSending(true)}
      >
        {count} note{count === 1 ? "" : "s"}
      </Button>
      {sending && count > 0 ? (
        <SendCommentsDialog
          worktree={worktree}
          comments={comments}
          onClose={() => setSending(false)}
          onShowAgent={onShowAgent}
        />
      ) : null}
    </>
  );
}
