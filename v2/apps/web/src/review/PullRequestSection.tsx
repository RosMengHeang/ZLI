import type { PullRequestInfo, PullRequestStatusResult, WorktreeProjection } from "@zli-v2/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { useRuntime } from "../runtime/RuntimeProvider.js";
import { Badge, type BadgeTone } from "../ui/Badge.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { openExternalLink, useCopyFeedback } from "./links.js";
import { PullRequestDialog } from "./PullRequestDialog.js";
import { pullRequestStatus } from "./pullRequestClient.js";

const stateLabel: Record<PullRequestInfo["state"], string> = { OPEN: "Open", CLOSED: "Closed", MERGED: "Merged" };
const stateTone: Record<PullRequestInfo["state"], BadgeTone> = { OPEN: "success", CLOSED: "neutral", MERGED: "info" };

function pullRequestStateLabel(pullRequest: PullRequestInfo): string {
  return pullRequest.state === "OPEN" && pullRequest.isDraft ? "Draft" : stateLabel[pullRequest.state];
}

/**
 * The pull request row of the Changes panel: the branch's pull request when there is one, or the
 * action that creates it. `checkKey` changes whenever the panel refreshes, which checks again.
 */
export function PullRequestSection({
  worktree,
  base,
  checkKey,
  onCommitFirst,
}: {
  worktree: WorktreeProjection;
  /** Base branch the person chose for merging, if any; the dialog starts with it. */
  base: string | undefined;
  checkKey: number;
  onCommitFirst(): void;
}) {
  const { bridge, dispatch } = useRuntime();
  const [status, setStatus] = useState<PullRequestStatusResult>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [copyState, copy] = useCopyFeedback();
  const latest = useRef(0);
  const commitAfterClose = useRef(false);
  const worktreeId = worktree.worktreeId;

  const check = useCallback(async () => {
    const request = ++latest.current;
    setChecking(true);
    setError(undefined);
    try {
      const next = await pullRequestStatus(dispatch, worktreeId);
      if (request === latest.current) setStatus(next);
    } catch (cause) {
      if (request === latest.current) setError(cause instanceof Error ? cause.message : "Checking failed.");
    } finally {
      if (request === latest.current) setChecking(false);
    }
  }, [dispatch, worktreeId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: checkKey is the trigger to check again.
  useEffect(() => {
    setStatus(undefined);
    void check();
  }, [check, checkKey]);

  // The dialog gives focus back to the Create PR button as it closes, so the commit field is
  // focused only once that has happened.
  useEffect(() => {
    if (dialogOpen || !commitAfterClose.current) return;
    commitAfterClose.current = false;
    onCommitFirst();
  }, [dialogOpen, onCommitFirst]);

  const pullRequest = status?.pullRequest;
  const problem = error ?? status?.problem?.message;
  const canCreate = !!status && !status.problem && !error && pullRequest?.state !== "OPEN";

  return (
    <fieldset className="review-pr">
      <legend className="sr-only">Pull request</legend>
      {checking && !status ? (
        <span className="review-pr-state" role="status">
          <span className="spinner" aria-hidden="true" />
          Checking GitHub for a pull request
        </span>
      ) : problem ? (
        <span className="review-pr-state is-problem" role="alert">
          <Icon name="alert" size={13} />
          <span>{problem}</span>
        </span>
      ) : pullRequest ? (
        <span className="review-pr-state">
          <Icon name="pullRequest" size={13} />
          <span className="review-pr-number">#{pullRequest.number}</span>
          <Badge
            tone={pullRequest.isDraft && pullRequest.state === "OPEN" ? "quiet" : stateTone[pullRequest.state]}
            dot
          >
            {pullRequestStateLabel(pullRequest)}
          </Badge>
        </span>
      ) : (
        <span className="review-pr-state">
          <Icon name="pullRequest" size={13} />
          <span>No pull request for this branch yet</span>
        </span>
      )}
      {pullRequest ? (
        <>
          <IconButton
            label={
              copyState === "copied" ? "Link copied" : copyState === "failed" ? "Copy failed" : "Copy pull request link"
            }
            icon={copyState === "copied" ? "check" : "copy"}
            size="sm"
            onClick={() => copy(pullRequest.url)}
          />
          <Button
            size="sm"
            icon="externalLink"
            onClick={() =>
              void openExternalLink(bridge, pullRequest.url).then((failure) => failure && setError(failure))
            }
          >
            View PR
          </Button>
        </>
      ) : null}
      {problem ? (
        <Button variant="ghost" size="sm" icon="reload" loading={checking} onClick={() => void check()}>
          Check again
        </Button>
      ) : canCreate ? (
        <Button size="sm" icon="pullRequest" onClick={() => setDialogOpen(true)}>
          Create PR
        </Button>
      ) : null}
      {dialogOpen ? (
        <PullRequestDialog
          worktree={worktree}
          base={base}
          onClose={() => setDialogOpen(false)}
          onCreated={(created) => setStatus((current) => (current ? { ...current, pullRequest: created } : current))}
          onCommitFirst={() => {
            commitAfterClose.current = true;
            setDialogOpen(false);
          }}
        />
      ) : null}
    </fieldset>
  );
}
