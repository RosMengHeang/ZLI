import type { WorktreeProjection } from "@zli-v2/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import type { SessionMode } from "../sessions/sessions.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import {
  commentLocation,
  editReviewComment,
  formatCommentsMessage,
  removeReviewComments,
  useReviewComments,
} from "./reviewComments.js";
import { type SentNotice, SendToAgentButton } from "./SendToAgentButton.js";

/** Comments waiting to be sent, with the action that sends them to an agent. */
export function ReviewCommentList({
  worktree,
  onOpenFile,
  onShowAgent,
  onNotice,
}: {
  worktree: WorktreeProjection;
  onOpenFile(path: string): void;
  onShowAgent?: ((sessionId: string, mode: SessionMode) => void) | undefined;
  onNotice?: ((notice: SentNotice) => void) | undefined;
}) {
  const comments = useReviewComments(worktree.worktreeId);
  const [editing, setEditing] = useState<string>();
  const [editText, setEditText] = useState("");
  const message = useMemo(() => formatCommentsMessage(comments, worktree.branch), [comments, worktree.branch]);
  const editRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) editRef.current?.focus();
  }, [editing]);

  if (comments.length === 0) return null;

  const saveEdit = () => {
    const body = editText.trim();
    if (!editing || !body) return;
    editReviewComment(editing, body);
    setEditing(undefined);
  };

  return (
    <section className="review-comments" aria-label="Review comments">
      <header className="review-comments-header">
        <Icon name="message" size={13} />
        <span className="review-comments-title">
          {comments.length} comment{comments.length === 1 ? "" : "s"}
        </span>
        <span className="review-comments-note">not sent yet</span>
        <SendToAgentButton
          worktree={worktree}
          label="Send to agent"
          dialogLabel="Send comments"
          dialogTitle={`Send ${comments.length} comment${comments.length === 1 ? "" : "s"}`}
          message={message}
          noAgentMessage={`No agent is running in ${worktree.branch}. Start one with New agent, then send the comments. They stay here until then.`}
          icon="message"
          onSent={() => removeReviewComments(comments.map((comment) => comment.id))}
          onNotice={onNotice}
          onShowAgent={onShowAgent}
        >
          Send to agent
        </SendToAgentButton>
      </header>
      <ul className="review-comment-items">
        {comments.map((comment) => {
          const location = commentLocation(comment);
          return (
            <li className="review-comment" key={comment.id}>
              <div className="review-comment-head">
                <button
                  type="button"
                  className="review-comment-location"
                  title={`Show the diff of ${comment.path}`}
                  onClick={() => onOpenFile(comment.path)}
                >
                  {location}
                </button>
                <IconButton
                  label={`Edit comment on ${location}`}
                  tooltip="Edit"
                  icon="pencil"
                  size="sm"
                  iconSize={12}
                  onClick={() => {
                    setEditing(comment.id);
                    setEditText(comment.body);
                  }}
                />
                <IconButton
                  label={`Remove comment on ${location}`}
                  tooltip="Remove"
                  icon="trash"
                  size="sm"
                  iconSize={12}
                  onClick={() => removeReviewComments([comment.id])}
                />
              </div>
              <code className="review-comment-excerpt">
                {comment.excerpt[0]}
                {comment.excerpt.length > 1 ? <span> and {comment.excerpt.length - 1} more</span> : null}
              </code>
              {editing === comment.id ? (
                <form
                  className="review-comment-edit"
                  onSubmit={(event) => {
                    event.preventDefault();
                    saveEdit();
                  }}
                >
                  <textarea
                    className="textarea"
                    aria-label={`Comment on ${location}`}
                    rows={3}
                    value={editText}
                    ref={editRef}
                    onChange={(event) => setEditText(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                        event.preventDefault();
                        saveEdit();
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        setEditing(undefined);
                      }
                    }}
                  />
                  <div className="review-comment-edit-actions">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(undefined)}>
                      Cancel
                    </Button>
                    <Button size="sm" variant="primary" type="submit" shortcut="Mod+Enter" disabled={!editText.trim()}>
                      Save
                    </Button>
                  </div>
                </form>
              ) : (
                <p className="review-comment-body">{comment.body}</p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
