import type { PullRequestCheck, PullRequestInfo, WorktreeProjection } from "@zli-v2/contracts";
import { type KeyboardEvent, useEffect, useState } from "react";

import { Markdown } from "../chat/Markdown.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { relativeTime, type SessionMode } from "../sessions/sessions.js";
import { checksView } from "../shell/overview.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { openExternalLink } from "./links.js";
import { MergePullRequestDialog } from "./MergePullRequestDialog.js";
import { PullRequestCode } from "./PullRequestCode.js";
import { PullRequestComments } from "./PullRequestComments.js";
import { checksSummary } from "./PullRequestSection.js";
import { recordPullRequest, refreshPullRequest, usePullRequestEntry } from "./pullRequestStore.js";

import "./review.css";

type Tab = "summary" | "code";

const CHECK_ICON: Record<PullRequestCheck["state"], "check" | "alert" | "loader" | "x"> = {
  passed: "check",
  failed: "alert",
  pending: "loader",
  skipped: "x",
};

const CHECK_WORD: Record<PullRequestCheck["state"], string> = {
  passed: "Passed",
  failed: "Failed",
  pending: "Running",
  skipped: "Skipped",
};

/** The pull request's state as GitHub shows it: draft, open, merged or closed. */
export function pullRequestState(pullRequest: PullRequestInfo): "Draft" | "Open" | "Merged" | "Closed" {
  if (pullRequest.isDraft && pullRequest.state === "OPEN") return "Draft";
  return pullRequest.state === "OPEN" ? "Open" : pullRequest.state === "MERGED" ? "Merged" : "Closed";
}

/**
 * The worktree's pull request: what it is and whether it can merge on top, then two tabs. Summary has the
 * description, checks and reviews; Code has the files the branch changes and their diffs, without leaving it.
 */
export function PullRequestPane({
  worktree,
  onOpenChanges,
  onShowAgent,
  hideNumber = false,
}: {
  worktree: WorktreeProjection | undefined;
  onOpenChanges(): void;
  /** Leaves the number out of the byline when a bar above already shows it. */
  hideNumber?: boolean;
  onShowAgent?: ((sessionId: string, mode: SessionMode) => void) | undefined;
}) {
  const { bridge, dispatch } = useRuntime();
  const worktreeId = worktree?.worktreeId;
  const entry = usePullRequestEntry(worktreeId);
  const pullRequest = entry?.status?.pullRequest;
  const [tab, setTab] = useState<Tab>("summary");
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [checkKey, setCheckKey] = useState(0);
  const [showChecks, setShowChecks] = useState(true);

  // Opening the panel reads the pull request again, so it shows what GitHub has now.
  useEffect(() => {
    setTab("summary");
    setError(undefined);
    setNotice(undefined);
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
  const count = checksView(pullRequest);
  const mergeable = pullRequest.state === "OPEN" && !pullRequest.isDraft;
  const state = pullRequestState(pullRequest);
  const base = pullRequest.baseRefName ?? entry?.status?.defaults.base;
  const head = pullRequest.headRefName ?? worktree.branch;

  const selectTab = (next: Tab) => setTab(next);
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next: Tab = tab === "summary" ? "code" : "summary";
    setTab(next);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus();
  };

  return (
    <div className="pr-pane">
      <header className="pr-pane-head">
        <div className="pr-pane-title-row">
          <h2 className="pr-pane-title">{pullRequest.title ?? `Pull request #${pullRequest.number}`}</h2>
          <div className="pr-pane-actions">
            <IconButton label="Open on GitHub" icon="externalLink" size="sm" onClick={open} />
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
        </div>
        <div className="pr-pane-byline">
          <span className={`pr-state is-${state.toLowerCase()}`}>
            <Icon name={state === "Merged" ? "merge" : "pullRequest"} size={12} />
            {state}
          </span>
          {hideNumber ? null : <span className="pr-pane-number">#{pullRequest.number}</span>}
          {pullRequest.author ? <span className="pr-pane-author">{pullRequest.author.login}</span> : null}
          <span className="pr-pane-branches is-mono" title={`${head} into ${base ?? "base"}`}>
            <span className="pr-pane-branch">{head}</span>
            <Icon name="arrowRight" size={11} />
            <span className="pr-pane-branch">{base ?? "base"}</span>
          </span>
          {pullRequest.updatedAt ? (
            <span className="pr-pane-time">updated {relativeTime(pullRequest.updatedAt)} ago</span>
          ) : null}
        </div>
      </header>
      <div className="pr-pane-tabs" role="tablist" aria-label="Pull request" onKeyDown={onTabKey}>
        <button
          type="button"
          role="tab"
          data-tab="summary"
          aria-selected={tab === "summary"}
          tabIndex={tab === "summary" ? 0 : -1}
          className={`pr-pane-tab${tab === "summary" ? " is-on" : ""}`}
          onClick={() => selectTab("summary")}
        >
          Summary
        </button>
        <button
          type="button"
          role="tab"
          data-tab="code"
          aria-selected={tab === "code"}
          tabIndex={tab === "code" ? 0 : -1}
          className={`pr-pane-tab${tab === "code" ? " is-on" : ""}`}
          onClick={() => selectTab("code")}
        >
          Code
          {pullRequest.changedFiles !== undefined ? (
            <span className="pr-pane-tab-count">{pullRequest.changedFiles}</span>
          ) : null}
        </button>
        <span className="pr-pane-spacer" />
        {pullRequest.additions !== undefined && pullRequest.deletions !== undefined ? (
          <span className="pr-pane-size">
            <span className="env-add">+{pullRequest.additions}</span>
            <span className="env-del">−{pullRequest.deletions}</span>
          </span>
        ) : null}
      </div>
      {tab === "code" ? (
        <div className="pr-pane-code" role="tabpanel" aria-label="Code">
          <PullRequestCode worktree={worktree} baseRefName={base} onOpenChanges={onOpenChanges} />
        </div>
      ) : (
        <div className="pr-pane-body" role="tabpanel" aria-label="Summary">
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
          <section className="pr-pane-section" aria-label="Description">
            {pullRequest.body ? (
              <div className="pr-pane-description">
                <Markdown text={pullRequest.body} />
              </div>
            ) : (
              <p className="pr-pane-note">The author left no description.</p>
            )}
          </section>
          {checks.length > 0 && summary ? (
            <section className="pr-pane-section" aria-label="Checks">
              <button
                type="button"
                className={`pr-pane-checks-head is-${summary.tone}`}
                aria-expanded={showChecks}
                onClick={() => setShowChecks((value) => !value)}
              >
                <Icon
                  name={summary.tone === "danger" ? "alert" : summary.tone === "success" ? "check" : "loader"}
                  size={13}
                />
                <span className="pr-pane-checks-text">{summary.text}</span>
                {count ? <span className={`pr-checks-count is-${count.tone}`}>{count.count}</span> : null}
                <Icon name={showChecks ? "chevronUp" : "chevronDown"} size={12} />
              </button>
              {showChecks ? (
                <ul className="pr-pane-check-list">
                  {checks.map((check) => (
                    <li key={`${check.workflow ?? ""}/${check.name}`} className={`pr-pane-check is-${check.state}`}>
                      <Icon name={CHECK_ICON[check.state]} size={13} />
                      <span className="pr-pane-check-name">{check.name}</span>
                      <span className="pr-pane-check-state">{CHECK_WORD[check.state]}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
          <section className="pr-pane-section" aria-label="Comments">
            <h3 className="pr-pane-section-title">Comments</h3>
            <PullRequestComments worktree={worktree} checkKey={checkKey} onShowAgent={onShowAgent} />
          </section>
        </div>
      )}
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
