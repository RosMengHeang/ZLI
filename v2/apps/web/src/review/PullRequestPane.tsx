import type { PullRequestCheck, WorktreeProjection } from "@zli-v2/contracts";
import { useEffect, useState } from "react";

import { Markdown } from "../chat/Markdown.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { relativeTime, type SessionMode } from "../sessions/sessions.js";
import { Button } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { openExternalLink } from "./links.js";
import { MergePullRequestDialog } from "./MergePullRequestDialog.js";
import { PullRequestComments } from "./PullRequestComments.js";
import { checksSummary } from "./PullRequestSection.js";
import { recordPullRequest, refreshPullRequest, usePullRequestEntry } from "./pullRequestStore.js";

import "./review.css";

const CHECK_ICON: Record<PullRequestCheck["state"], "check" | "alert" | "loader" | "x"> = {
  passed: "check",
  failed: "alert",
  pending: "loader",
  skipped: "x",
};

/**
 * The worktree's pull request in the side panel: what it is, whether it can merge, and what reviewers
 * said, without leaving ZLI. Summary reads like the pull request's page on GitHub; Code opens Changes.
 */
export function PullRequestPane({
  worktree,
  onOpenChanges,
  onShowAgent,
}: {
  worktree: WorktreeProjection | undefined;
  onOpenChanges(): void;
  onShowAgent?: ((sessionId: string, mode: SessionMode) => void) | undefined;
}) {
  const { bridge, dispatch } = useRuntime();
  const worktreeId = worktree?.worktreeId;
  const entry = usePullRequestEntry(worktreeId);
  const pullRequest = entry?.status?.pullRequest;
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [checkKey, setCheckKey] = useState(0);
  const [showChecks, setShowChecks] = useState(true);
  const [showDescription, setShowDescription] = useState(true);

  // Opening the panel reads the pull request again, so it shows what GitHub has now.
  useEffect(() => {
    if (worktreeId) void refreshPullRequest(dispatch, worktreeId, true);
  }, [dispatch, worktreeId]);

  if (!worktree) {
    return <p className="pr-pane-empty">Pick an agent or a worktree to see its pull request.</p>;
  }
  if (!pullRequest) {
    return (
      <div className="pr-pane-empty">
        {entry?.checking || !entry ? (
          <>
            <span className="spinner" aria-hidden="true" />
            <span>Looking for the pull request of {worktree.branch}</span>
          </>
        ) : (
          <>
            <span>
              {entry.error ?? entry.status?.problem?.message ?? `${worktree.branch} has no pull request yet.`}
            </span>
            <Button size="sm" icon="diff" onClick={onOpenChanges}>
              Open Changes
            </Button>
          </>
        )}
      </div>
    );
  }

  const open = () => {
    void openExternalLink(bridge, pullRequest.url).then((failure) => {
      if (failure) setError(failure);
    });
  };
  const checks = pullRequest.checks ?? [];
  const summary = checks.length > 0 ? checksSummary(checks) : undefined;
  const mergeable = pullRequest.state === "OPEN" && !pullRequest.isDraft;
  const state = pullRequest.isDraft
    ? "Draft"
    : pullRequest.state === "OPEN"
      ? "Open"
      : pullRequest.state === "MERGED"
        ? "Merged"
        : "Closed";

  return (
    <div className="pr-pane">
      <header className="pr-pane-head">
        <div className="pr-pane-title-row">
          <button type="button" className="pr-pane-number" onClick={open} title="Open on GitHub">
            #{pullRequest.number}
            <Icon name="externalLink" size={11} />
          </button>
          <span className={`env-pr-state is-${state.toLowerCase()}`}>{state}</span>
          <span className="pr-pane-spacer" />
          {mergeable ? (
            <Button
              variant="primary"
              size="sm"
              icon="merge"
              disabled={!!pullRequest.autoMerge}
              title={pullRequest.autoMerge ? "Auto-merge is on. GitHub merges it once checks pass." : undefined}
              onClick={() => setMerging(true)}
            >
              {pullRequest.autoMerge ? "Auto-merge on" : "Merge"}
            </Button>
          ) : null}
        </div>
        <h2 className="pr-pane-title">{pullRequest.title ?? `Pull request #${pullRequest.number}`}</h2>
        <div className="pr-pane-meta">
          {pullRequest.author ? <span>{pullRequest.author.login}</span> : null}
          {pullRequest.updatedAt ? <span>updated {relativeTime(pullRequest.updatedAt)} ago</span> : null}
        </div>
        <div className="pr-pane-meta">
          <span className="pr-pane-branches is-mono">
            {pullRequest.baseRefName ?? entry?.status?.defaults.base ?? "base"}
            <Icon name="arrowLeft" size={11} />
            {pullRequest.headRefName ?? worktree.branch}
          </span>
          <span className="pr-pane-spacer" />
          {pullRequest.changedFiles !== undefined ? (
            <span className="pr-pane-files">
              <Icon name="file" size={12} />
              {pullRequest.changedFiles} {pullRequest.changedFiles === 1 ? "file" : "files"}
              {pullRequest.additions !== undefined ? <span className="env-add">+{pullRequest.additions}</span> : null}
              {pullRequest.deletions !== undefined ? <span className="env-del">−{pullRequest.deletions}</span> : null}
            </span>
          ) : null}
        </div>
      </header>
      <div className="pr-pane-tabs" role="tablist" aria-label="Pull request">
        <button type="button" role="tab" aria-selected="true" className="pr-pane-tab is-on">
          Summary
        </button>
        <button type="button" role="tab" aria-selected="false" className="pr-pane-tab" onClick={onOpenChanges}>
          Code
        </button>
        <span className="pr-pane-spacer" />
        {summary ? (
          <span className={`pr-pane-checks is-${summary.tone}`}>
            <Icon
              name={summary.tone === "danger" ? "alert" : summary.tone === "success" ? "check" : "loader"}
              size={12}
            />
            {summary.text}
          </span>
        ) : null}
      </div>
      <div className="pr-pane-body">
        {error ? (
          <p className="inline-error" role="alert">
            {error}
          </p>
        ) : notice ? (
          <p className="env-line is-done" role="status">
            <Icon name="check" size={13} />
            <span>{notice}</span>
          </p>
        ) : null}
        <section className="pr-pane-section">
          <button
            type="button"
            className="pr-pane-section-head"
            aria-expanded={showDescription}
            onClick={() => setShowDescription((value) => !value)}
          >
            Description
            <Icon name={showDescription ? "chevronDown" : "chevronRight"} size={12} />
          </button>
          {showDescription ? (
            pullRequest.body ? (
              <div className="pr-pane-description">
                <Markdown text={pullRequest.body} />
              </div>
            ) : (
              <p className="pr-pane-note">No description.</p>
            )
          ) : null}
        </section>
        {checks.length > 0 ? (
          <section className="pr-pane-section">
            <button
              type="button"
              className="pr-pane-section-head"
              aria-expanded={showChecks}
              onClick={() => setShowChecks((value) => !value)}
            >
              Checks
              <Icon name={showChecks ? "chevronDown" : "chevronRight"} size={12} />
            </button>
            {showChecks ? (
              <ul className="pr-pane-check-list">
                {checks.map((check) => (
                  <li key={`${check.workflow ?? ""}/${check.name}`} className={`pr-pane-check is-${check.state}`}>
                    <Icon name={CHECK_ICON[check.state]} size={13} />
                    <span className="pr-pane-check-name">{check.name}</span>
                    <span className="pr-pane-check-state">
                      {check.state === "passed"
                        ? "Passed"
                        : check.state === "failed"
                          ? "Failed"
                          : check.state === "pending"
                            ? "Running"
                            : "Skipped"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}
        <section className="pr-pane-section">
          <div className="pr-pane-section-head is-static">Comments</div>
          <PullRequestComments worktree={worktree} checkKey={checkKey} onShowAgent={onShowAgent} />
        </section>
      </div>
      {merging ? (
        <MergePullRequestDialog
          worktree={worktree}
          pullRequest={pullRequest}
          onClose={() => setMerging(false)}
          onMerged={(result) => {
            setMerging(false);
            recordPullRequest(worktree.worktreeId, result.pullRequest);
            setNotice(`Merged #${result.pullRequest.number}.`);
            setCheckKey((value) => value + 1);
          }}
          onAutoMerge={(result) => {
            setMerging(false);
            recordPullRequest(worktree.worktreeId, result.pullRequest);
          }}
        />
      ) : null}
    </div>
  );
}
