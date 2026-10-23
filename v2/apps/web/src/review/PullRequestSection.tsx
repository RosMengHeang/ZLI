import type { PullRequestCheck, PullRequestInfo, WorktreeProjection } from "@zli-v2/contracts";
import { lazy, Suspense, useEffect, useRef, useState } from "react";

import { useRuntime } from "../runtime/RuntimeProvider.js";
import type { SessionMode } from "../sessions/sessions.js";
import { Badge, type BadgeTone } from "../ui/Badge.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { openExternalLink, useCopyFeedback } from "./links.js";
import { PullRequestDialog } from "./PullRequestDialog.js";
import { readCheckLog } from "./pullRequestClient.js";
import { recordPullRequest, refreshPullRequest, usePullRequestEntry } from "./pullRequestStore.js";
import { SendToAgentDialog } from "./SendToAgentDialog.js";

const stateLabel: Record<PullRequestInfo["state"], string> = { OPEN: "Open", CLOSED: "Closed", MERGED: "Merged" };
const stateTone: Record<PullRequestInfo["state"], BadgeTone> = { OPEN: "success", CLOSED: "neutral", MERGED: "info" };

function pullRequestStateLabel(pullRequest: PullRequestInfo): string {
  return pullRequest.state === "OPEN" && pullRequest.isDraft ? "Draft" : stateLabel[pullRequest.state];
}

/**
 * The pull request row of the Changes panel: the branch's pull request when there is one, or the
 * action that creates it. Status comes from the shared store, which the shell keeps current;
 * `checkKey` changes whenever the panel refreshes, which checks again.
 */
export function PullRequestSection({
  worktree,
  base,
  checkKey,
  onCommitFirst,
  onShowAgent,
}: {
  worktree: WorktreeProjection;
  /** Base branch the person chose for merging, if any; the dialog starts with it. */
  base: string | undefined;
  checkKey: number;
  onCommitFirst(): void;
  onShowAgent?: ((sessionId: string, mode: SessionMode) => void) | undefined;
}) {
  const { bridge, dispatch } = useRuntime();
  const entry = usePullRequestEntry(worktree.worktreeId);
  const status = entry?.status;
  const checking = entry?.checking ?? false;
  const error = entry?.error;
  const [dialogOpen, setDialogOpen] = useState(false);
  const [linkError, setLinkError] = useState<string>();
  const [copyState, copy] = useCopyFeedback();
  const commitAfterClose = useRef(false);
  const worktreeId = worktree.worktreeId;

  // The panel's refresh button is an explicit ask: the answer is fetched again, even a fresh one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: checkKey is the trigger to check again.
  useEffect(() => {
    setLinkError(undefined);
    void refreshPullRequest(dispatch, worktreeId, true);
  }, [dispatch, worktreeId, checkKey]);

  // The dialog gives focus back to the Create PR button as it closes, so the commit field is
  // focused only once that has happened.
  useEffect(() => {
    if (dialogOpen || !commitAfterClose.current) return;
    commitAfterClose.current = false;
    onCommitFirst();
  }, [dialogOpen, onCommitFirst]);

  const pullRequest = status?.pullRequest;
  const problem = linkError ?? error ?? status?.problem?.message;
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
          {pullRequest.reviewDecision === "APPROVED" ? (
            <Badge tone="success" dot>
              Approved
            </Badge>
          ) : pullRequest.reviewDecision === "CHANGES_REQUESTED" ? (
            <Badge tone="danger" dot>
              Changes requested
            </Badge>
          ) : null}
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
              void openExternalLink(bridge, pullRequest.url).then((failure) => failure && setLinkError(failure))
            }
          >
            View PR
          </Button>
        </>
      ) : null}
      {problem ? (
        <Button
          variant="ghost"
          size="sm"
          icon="reload"
          loading={checking}
          onClick={() => void refreshPullRequest(dispatch, worktreeId, true)}
        >
          Check again
        </Button>
      ) : canCreate ? (
        <Button size="sm" icon="pullRequest" onClick={() => setDialogOpen(true)}>
          Create PR
        </Button>
      ) : null}
      {pullRequest?.checks ? (
        <PullRequestChecks worktree={worktree} pullRequest={pullRequest} onShowAgent={onShowAgent} />
      ) : null}
      {dialogOpen ? (
        <Suspense fallback={null}>
          <PullRequestDialog
            worktree={worktree}
            base={base}
            onClose={() => setDialogOpen(false)}
            onCreated={(created) => recordPullRequest(worktreeId, created)}
            onCommitFirst={() => {
              commitAfterClose.current = true;
              setDialogOpen(false);
            }}
          />
        </Suspense>
      ) : null}
    </fieldset>
  );
}

const checkIcon: Record<PullRequestCheck["state"], "check" | "alert" | "loader" | "x"> = {
  passed: "check",
  failed: "alert",
  pending: "loader",
  skipped: "x",
};

export function checksSummary(checks: readonly PullRequestCheck[]): { text: string; tone: BadgeTone } {
  const failed = checks.filter((check) => check.state === "failed").length;
  const pending = checks.filter((check) => check.state === "pending").length;
  if (failed > 0) {
    return { text: `${failed} check${failed === 1 ? "" : "s"} failed`, tone: "danger" };
  }
  if (pending > 0) {
    return { text: `${pending} check${pending === 1 ? "" : "s"} running`, tone: "warning" };
  }
  const passed = checks.filter((check) => check.state === "passed").length;
  if (passed === 0) return { text: "No checks ran", tone: "neutral" };
  const skipped = checks.length - passed;
  return {
    text: skipped > 0 ? `${passed} passed, ${skipped} skipped` : `${passed} check${passed === 1 ? "" : "s"} passed`,
    tone: "success",
  };
}

/** The pull request's CI checks, each with a link and a way to hand a failure to an agent. */
export function PullRequestChecks({
  worktree,
  pullRequest,
  onShowAgent,
}: {
  worktree: WorktreeProjection;
  pullRequest: PullRequestInfo;
  onShowAgent?: ((sessionId: string, mode: SessionMode) => void) | undefined;
}) {
  const { bridge } = useRuntime();
  const checks = pullRequest.checks ?? [];
  const [fixing, setFixing] = useState<PullRequestCheck>();
  const summary = checksSummary(checks);
  return (
    <div className="pr-checks">
      <span className="pr-checks-summary">
        <Badge tone={summary.tone} dot>
          {summary.text}
        </Badge>
      </span>
      <ul className="pr-check-list" aria-label="Checks">
        {checks.map((check) => (
          <li className={`pr-check is-${check.state}`} key={`${check.workflow ?? ""}:${check.name}`}>
            <Icon name={checkIcon[check.state]} size={12} />
            <span className="pr-check-name" title={check.workflow ? `${check.workflow} · ${check.name}` : check.name}>
              {check.name}
            </span>
            {check.url ? (
              <IconButton
                label={`Open ${check.name} on GitHub`}
                tooltip="Open check"
                icon="externalLink"
                size="xs"
                iconSize={11}
                onClick={() => void openExternalLink(bridge, check.url ?? "")}
              />
            ) : null}
            {check.state === "failed" && check.url ? (
              <Button variant="ghost" size="xs" icon="message" onClick={() => setFixing(check)}>
                Send to agent
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {fixing ? (
        <FixCheckDialog
          worktree={worktree}
          pullRequest={pullRequest}
          check={fixing}
          onClose={() => setFixing(undefined)}
          onShowAgent={onShowAgent}
        />
      ) : null}
    </div>
  );
}

export function formatCheckMessage(
  check: PullRequestCheck,
  pullRequest: PullRequestInfo,
  branch: string,
  log: { excerpt: string; truncated: boolean },
): string {
  const intro = `The CI check "${check.name}"${check.workflow ? ` (workflow "${check.workflow}")` : ""} failed on pull request #${pullRequest.number} for the branch ${branch}.\n${check.url}\nPlease find the cause and fix it.`;
  if (!log.excerpt) return `${intro}\n\nThe job log had no readable output. Open the link above for details.`;
  return `${intro}\n\nOutput of the failed step${log.truncated ? " (earlier lines left out)" : ""}:\n\`\`\`text\n${log.excerpt}\n\`\`\``;
}

/** Reads the failed step's log from GitHub, then lets the person send it to an agent as a fix task. */
function FixCheckDialog({
  worktree,
  pullRequest,
  check,
  onClose,
  onShowAgent,
}: {
  worktree: WorktreeProjection;
  pullRequest: PullRequestInfo;
  check: PullRequestCheck;
  onClose(): void;
  onShowAgent?: ((sessionId: string, mode: SessionMode) => void) | undefined;
}) {
  const { dispatch } = useRuntime();
  const [log, setLog] = useState<{ excerpt: string; truncated: boolean }>();
  const [preparing, setPreparing] = useState<string>();
  const [loadError, setLoadError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setPreparing("Reading the failed step's log from GitHub");
    readCheckLog(dispatch, worktree.worktreeId, check.url ?? "").then(
      (result) => {
        if (cancelled) return;
        setLog(result);
        setPreparing(undefined);
      },
      (cause: unknown) => {
        if (cancelled) return;
        // The message is still useful without the log: it names the check and links to it.
        setLog({ excerpt: "", truncated: false });
        setLoadError(cause instanceof Error ? cause.message : "The log could not be read.");
        setPreparing(undefined);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [dispatch, worktree.worktreeId, check.url]);

  return (
    <Suspense fallback={null}>
      <SendToAgentDialog
        label="Send failed check"
        title={`Fix ${check.name}`}
        worktree={worktree}
        message={log ? formatCheckMessage(check, pullRequest, worktree.branch, log) : ""}
        preparing={preparing}
        notice={
          loadError ? `The log could not be read: ${loadError} The message links to the check instead.` : undefined
        }
        noAgentMessage={`No agent is running in ${worktree.branch}. Start one with New agent, then send the failed check.`}
        onClose={onClose}
        onShowAgent={onShowAgent}
      />
    </Suspense>
  );
}
