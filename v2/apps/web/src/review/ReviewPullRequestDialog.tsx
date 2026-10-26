import type {
  PullRequestInfo,
  PullRequestReviewEvent,
  PullRequestUpdateResult,
  WorktreeProjection,
} from "@zli-v2/contracts";
import { type KeyboardEvent, useState } from "react";

import { useRuntime } from "../runtime/RuntimeProvider.js";
import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Field } from "../ui/Field.js";
import { Icon } from "../ui/Icon.js";
import { Segmented } from "../ui/Segmented.js";
import { reviewPullRequest } from "./pullRequestClient.js";

export const reviewEvents: Record<
  PullRequestReviewEvent,
  { label: string; flag: string; detail: string; bodyRequired: boolean }
> = {
  COMMENT: {
    label: "Comment",
    flag: "--comment",
    detail: "Leaves feedback without approving or blocking the merge.",
    bodyRequired: true,
  },
  APPROVE: {
    label: "Approve",
    flag: "--approve",
    detail: "Approves the changes. The comment is optional.",
    bodyRequired: false,
  },
  REQUEST_CHANGES: {
    label: "Request changes",
    flag: "--request-changes",
    detail: "Asks for changes before the pull request is merged.",
    bodyRequired: true,
  },
};

/** Submits a review of the branch's pull request as the account GitHub CLI is signed in with. */
export function ReviewPullRequestDialog({
  worktree,
  pullRequest,
  onClose,
  onReviewed,
}: {
  worktree: WorktreeProjection;
  pullRequest: PullRequestInfo;
  onClose(): void;
  onReviewed(result: PullRequestUpdateResult): void;
}) {
  const { dispatch } = useRuntime();
  const [event, setEvent] = useState<PullRequestReviewEvent>("COMMENT");
  const [body, setBody] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const choice = reviewEvents[event];
  const missingBody = choice.bodyRequired && !body.trim();

  const submit = async () => {
    if (missingBody || running) return;
    setRunning(true);
    setError(undefined);
    try {
      onReviewed(await reviewPullRequest(dispatch, worktree.worktreeId, { event, body }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The review could not be sent.");
      setRunning(false);
    }
  };

  const closeOnEscape = (keyEvent: KeyboardEvent<HTMLDivElement>) => {
    if (keyEvent.key === "Escape" && !running) onClose();
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape from anywhere inside the dialog closes it.
    <div onKeyDown={closeOnEscape}>
      <Dialog
        label="Review pull request"
        className="pr-dialog"
        size="sm"
        title={`Review pull request #${pullRequest.number}`}
        subtitle={
          <>
            <span className="is-mono">{worktree.branch}</span> on GitHub
          </>
        }
        onClose={() => {
          if (!running) onClose();
        }}
      >
        <div className="dialog-body">
          <Segmented<PullRequestReviewEvent>
            label="Review type"
            value={event}
            onChange={setEvent}
            options={(Object.keys(reviewEvents) as PullRequestReviewEvent[]).map((value) => ({
              value,
              label: reviewEvents[value].label,
            }))}
          />
          <p className="field-hint">{choice.detail}</p>
          <Field label={choice.bodyRequired ? "Comment" : "Comment (optional)"}>
            <textarea
              className="textarea pr-review-body"
              rows={5}
              value={body}
              placeholder={event === "REQUEST_CHANGES" ? "What should change?" : "Write a comment"}
              onChange={(change) => setBody(change.target.value)}
              onKeyDown={(keyEvent) => {
                if (keyEvent.key === "Enter" && (keyEvent.ctrlKey || keyEvent.metaKey)) {
                  keyEvent.preventDefault();
                  void submit();
                }
              }}
            />
          </Field>
          {error ? (
            <p className="inline-error pr-error" role="alert">
              <Icon name="alert" size={13} />
              <span>{error}</span>
            </p>
          ) : null}
        </div>
        <div className="dialog-footer">
          <span className="dialog-footer-note">Runs gh pr review {choice.flag}.</span>
          <Button variant="ghost" disabled={running} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="check"
            shortcut="Mod+Enter"
            loading={running}
            disabled={missingBody}
            onClick={() => void submit()}
          >
            Submit review
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
