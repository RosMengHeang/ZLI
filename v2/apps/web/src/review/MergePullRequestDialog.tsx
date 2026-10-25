import type {
  PullRequestInfo,
  PullRequestMergeMethod,
  PullRequestMergeResult,
  PullRequestUpdateResult,
  WorktreeProjection,
} from "@zli-v2/contracts";
import { type KeyboardEvent, useState } from "react";

import { useRuntime } from "../runtime/RuntimeProvider.js";
import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Icon } from "../ui/Icon.js";
import { Segmented } from "../ui/Segmented.js";
import { Switch } from "../ui/Switch.js";
import { checksSummary } from "./PullRequestSection.js";
import { mergePullRequest, setAutoMerge } from "./pullRequestClient.js";

const METHOD_KEY = "zli.review.mergeMethod";

export const mergeMethods: Record<PullRequestMergeMethod, { label: string; action: string; detail: string }> = {
  squash: { label: "Squash", action: "Squash and merge", detail: "Combines every commit into one on the base branch." },
  merge: { label: "Merge commit", action: "Merge", detail: "Keeps every commit and adds a merge commit." },
  rebase: {
    label: "Rebase",
    action: "Rebase and merge",
    detail: "Replays every commit onto the base branch, with no merge commit.",
  },
};

function savedMethod(): PullRequestMergeMethod {
  try {
    const value = localStorage.getItem(METHOD_KEY);
    return value === "merge" || value === "rebase" ? value : "squash";
  } catch {
    return "squash";
  }
}

/**
 * Merges the branch's open pull request on GitHub with the method the person picks. When GitHub is
 * likely to refuse, or just refused, it also offers to turn on auto-merge with that method instead.
 */
export function MergePullRequestDialog({
  worktree,
  pullRequest,
  onClose,
  onMerged,
  onAutoMerge,
}: {
  worktree: WorktreeProjection;
  pullRequest: PullRequestInfo;
  onClose(): void;
  onMerged(result: PullRequestMergeResult): void;
  onAutoMerge(result: PullRequestUpdateResult): void;
}) {
  const { dispatch } = useRuntime();
  const [method, setMethod] = useState<PullRequestMergeMethod>(savedMethod);
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [pending, setPending] = useState<"merge" | "auto">();
  const [error, setError] = useState<string>();
  const running = pending !== undefined;
  const checks = pullRequest.checks ?? [];
  const summary = checks.length > 0 ? checksSummary(checks) : undefined;
  const warning =
    pullRequest.reviewDecision === "CHANGES_REQUESTED"
      ? "A reviewer requested changes on this pull request."
      : summary && (summary.tone === "danger" || summary.tone === "warning")
        ? `${summary.text}. GitHub may refuse the merge until they pass.`
        : undefined;
  const mayBeBlocked =
    !!error ||
    pullRequest.reviewDecision === "REVIEW_REQUIRED" ||
    pullRequest.reviewDecision === "CHANGES_REQUESTED" ||
    (summary !== undefined && (summary.tone === "danger" || summary.tone === "warning"));
  const offerAutoMerge = mayBeBlocked && !pullRequest.autoMerge;

  const rememberMethod = () => {
    try {
      localStorage.setItem(METHOD_KEY, method);
    } catch {
      // Remembering the choice is a convenience.
    }
  };

  const submit = async () => {
    setPending("merge");
    setError(undefined);
    rememberMethod();
    try {
      onMerged(await mergePullRequest(dispatch, worktree.worktreeId, { method, deleteBranch }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The merge failed.");
      setPending(undefined);
    }
  };

  const mergeWhenReady = async () => {
    setPending("auto");
    setError(undefined);
    rememberMethod();
    try {
      onAutoMerge(await setAutoMerge(dispatch, worktree.worktreeId, { enabled: true, method }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Auto-merge could not be turned on.");
      setPending(undefined);
    }
  };

  const closeOnEscape = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !running) onClose();
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape from anywhere inside the dialog closes it.
    <div onKeyDown={closeOnEscape}>
      <Dialog
        label="Merge pull request"
        className="pr-dialog"
        size="sm"
        title={`Merge pull request #${pullRequest.number}`}
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
          {pullRequest.autoMerge ? (
            <div className="banner banner-info" role="status">
              <Icon name="merge" size={14} />
              <span className="banner-message">
                Auto-merge is on
                {pullRequest.autoMerge.method
                  ? ` (${mergeMethods[pullRequest.autoMerge.method].label.toLowerCase()})`
                  : ""}
                . GitHub merges this pull request once the required checks and reviews pass.
              </span>
            </div>
          ) : null}
          {warning ? (
            <div className="banner banner-warning" role="alert">
              <Icon name="alert" size={14} />
              <span className="banner-message">{warning}</span>
            </div>
          ) : null}
          <Segmented<PullRequestMergeMethod>
            label="Merge method"
            value={method}
            onChange={setMethod}
            options={(Object.keys(mergeMethods) as PullRequestMergeMethod[]).map((value) => ({
              value,
              label: mergeMethods[value].label,
            }))}
          />
          <p className="field-hint">{mergeMethods[method].detail}</p>
          <Switch
            label="Delete the branch on origin"
            hint="The branch and this worktree stay on this computer."
            checked={deleteBranch}
            onChange={setDeleteBranch}
          />
          {offerAutoMerge ? (
            <p className="field-hint">
              Merge when ready turns on auto-merge: GitHub merges with this method once the required checks and reviews
              pass. The branch on origin stays unless the repository deletes merged branches.
            </p>
          ) : null}
          {error ? (
            <p className="inline-error pr-error" role="alert">
              <Icon name="alert" size={13} />
              <span>{error}</span>
            </p>
          ) : null}
        </div>
        <div className="dialog-footer">
          <span className="dialog-footer-note">Runs gh pr merge --{method}.</span>
          <Button variant="ghost" disabled={running} onClick={onClose}>
            Cancel
          </Button>
          {offerAutoMerge ? (
            <Button loading={pending === "auto"} disabled={running} onClick={() => void mergeWhenReady()}>
              Merge when ready
            </Button>
          ) : null}
          <Button
            variant="primary"
            icon="merge"
            loading={pending === "merge"}
            disabled={running}
            onClick={() => void submit()}
          >
            {mergeMethods[method].action}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
