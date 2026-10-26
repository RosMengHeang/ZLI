import type {
  PullRequestInfo,
  PullRequestMergeMethod,
  PullRequestMergeResult,
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
import { mergePullRequest } from "./pullRequestClient.js";

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

/** Merges the branch's open pull request on GitHub with the method the person picks. */
export function MergePullRequestDialog({
  worktree,
  pullRequest,
  onClose,
  onMerged,
}: {
  worktree: WorktreeProjection;
  pullRequest: PullRequestInfo;
  onClose(): void;
  onMerged(result: PullRequestMergeResult): void;
}) {
  const { dispatch } = useRuntime();
  const [method, setMethod] = useState<PullRequestMergeMethod>(savedMethod);
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const checks = pullRequest.checks ?? [];
  const summary = checks.length > 0 ? checksSummary(checks) : undefined;
  const warning =
    pullRequest.reviewDecision === "CHANGES_REQUESTED"
      ? "A reviewer requested changes on this pull request."
      : summary && (summary.tone === "danger" || summary.tone === "warning")
        ? `${summary.text}. GitHub may refuse the merge until they pass.`
        : undefined;

  const submit = async () => {
    setRunning(true);
    setError(undefined);
    try {
      localStorage.setItem(METHOD_KEY, method);
    } catch {
      // Remembering the choice is a convenience.
    }
    try {
      onMerged(await mergePullRequest(dispatch, worktree.worktreeId, { method, deleteBranch }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The merge failed.");
      setRunning(false);
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
          <Button variant="primary" icon="merge" loading={running} onClick={() => void submit()}>
            {mergeMethods[method].action}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
