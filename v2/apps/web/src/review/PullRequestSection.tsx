import type {
  PullRequestCheck,
  PullRequestInfo,
  PullRequestMergeResult,
  PullRequestUpdateResult,
  WorktreeProjection,
} from "@zli-v2/contracts";
import { lazy, Suspense, useEffect, useRef, useState } from "react";

import { useRuntime } from "../runtime/RuntimeProvider.js";
import type { SessionMode } from "../sessions/sessions.js";
import { ConnectorLogo } from "../settings/connectorLogos.js";
import { requestSettings } from "../settings/openSettings.js";
import { Badge, type BadgeTone } from "../ui/Badge.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { forgeWords, isSetupProblem } from "./forgeWords.js";
import { openExternalLink, useCopyFeedback } from "./links.js";
import { PullRequestComments } from "./PullRequestComments.js";
import { PullRequestDialog } from "./PullRequestDialog.js";
import { readCheckLog, setAutoMerge } from "./pullRequestClient.js";
import { recordPullRequest, refreshPullRequest, usePullRequestEntry } from "./pullRequestStore.js";
import { SendToAgentDialog } from "./SendToAgentDialog.js";

const MergePullRequestDialog = lazy(() =>
  import("./MergePullRequestDialog.js").then((module) => ({ default: module.MergePullRequestDialog })),
);

const PublishDialog = lazy(() =>
  import("../forges/PublishDialog.js").then((module) => ({ default: module.PublishDialog })),
);

const ReviewPullRequestDialog = lazy(() =>
  import("./ReviewPullRequestDialog.js").then((module) => ({ default: module.ReviewPullRequestDialog })),
);

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
/**
 * Worktrees whose Create pull request dialog is open. Changes draws this section in one spot while there are
 * changes and in another once there are none, so a refresh can draw it anew; the dialog stays open through that.
 */
const createOpen = new Set<string>();

export function PullRequestSection({
  worktree,
  base,
  checkKey,
  reviewedAt,
  onCommitFirst,
  onShowAgent,
  onMerged,
}: {
  worktree: WorktreeProjection;
  /** Base branch the person chose for merging, if any; the dialog starts with it. */
  base: string | undefined;
  checkKey: number;
  /** When Changes last read the branch: an open, untouched Create dialog reads it again then. */
  reviewedAt?: string | undefined;
  onCommitFirst(): void;
  onShowAgent?: ((sessionId: string, mode: SessionMode) => void) | undefined;
  onMerged?: ((result: PullRequestMergeResult) => void) | undefined;
}) {
  const { bridge, dispatch } = useRuntime();
  const entry = usePullRequestEntry(worktree.worktreeId);
  const status = entry?.status;
  const checking = entry?.checking ?? false;
  const error = entry?.error;
  const [dialogOpen, setDialogShown] = useState(() => createOpen.has(worktree.worktreeId));
  const setDialogOpen = (open: boolean) => {
    if (open) createOpen.add(worktree.worktreeId);
    else createOpen.delete(worktree.worktreeId);
    setDialogShown(open);
  };
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [turningOff, setTurningOff] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: another worktree has other comments.
  useEffect(() => {
    setCommentsOpen(false);
    setReviewOpen(false);
  }, [worktreeId]);

  // The dialog gives focus back to the Create PR button as it closes, so the commit field is
  // focused only once that has happened.
  useEffect(() => {
    if (dialogOpen || !commitAfterClose.current) return;
    commitAfterClose.current = false;
    onCommitFirst();
  }, [dialogOpen, onCommitFirst]);

  const pullRequest = status?.pullRequest;
  const updated = (result: PullRequestUpdateResult) => {
    recordPullRequest(worktreeId, result.pullRequest);
    void refreshPullRequest(dispatch, worktreeId, true);
  };
  const turnOffAutoMerge = async () => {
    setTurningOff(true);
    setLinkError(undefined);
    try {
      updated(await setAutoMerge(dispatch, worktreeId, { enabled: false }));
    } catch (cause) {
      setLinkError(cause instanceof Error ? cause.message : "Auto-merge could not be turned off.");
    } finally {
      setTurningOff(false);
    }
  };
  const problem = linkError ?? error ?? status?.problem?.message;
  const canCreate = !!status && !status.problem && !error && pullRequest?.state !== "OPEN";
  const words = forgeWords(status?.forge);
  const { capabilities } = words;

  if (status?.problem?.code === "no_origin" && !linkError && !error) {
    return (
      <fieldset className="review-pr">
        <legend className="sr-only">{words.Noun}</legend>
        <div className="review-pr-setup">
          <span className="review-pr-setup-icon" aria-hidden="true">
            <Icon name="upload" size={14} />
          </span>
          <div className="review-pr-setup-copy">
            <span className="review-pr-setup-title">Not on a forge yet</span>
            <span className="review-pr-setup-detail">
              Publish it to GitHub, GitLab or Gitea to open pull requests from here.
            </span>
          </div>
          <div className="review-pr-setup-actions">
            <Button size="sm" variant="primary" onClick={() => setPublishOpen(true)}>
              Publish
            </Button>
          </div>
        </div>
        {publishOpen ? (
          <Suspense fallback={null}>
            <PublishDialog
              worktree={worktree}
              onClose={() => setPublishOpen(false)}
              onPublished={() => void refreshPullRequest(dispatch, worktreeId, true)}
            />
          </Suspense>
        ) : null}
      </fieldset>
    );
  }
  // Setup problems get their own card with the way out, instead of a CLI error in the row.
  if (status && isSetupProblem(status.problem) && !linkError && !error) {
    const unknown = status.problem?.code === "unknown_forge";
    return (
      <fieldset className="review-pr">
        <legend className="sr-only">{words.Noun}</legend>
        <div className="review-pr-setup" role="status">
          {unknown ? (
            <span className="review-pr-setup-icon" aria-hidden="true">
              <Icon name="globe" size={14} />
            </span>
          ) : (
            <ConnectorLogo id={words.kind} title={words.label} size={20} />
          )}
          <div className="review-pr-setup-copy">
            <span className="review-pr-setup-title">
              {unknown ? "Unknown forge" : `${words.label} isn't connected`}
            </span>
            <span className="review-pr-setup-detail">{status.problem?.message}</span>
          </div>
          <div className="review-pr-setup-actions">
            <Button
              variant="ghost"
              size="sm"
              icon="reload"
              aria-label="Check again"
              tooltip="Check again"
              loading={checking}
              onClick={() => void refreshPullRequest(dispatch, worktreeId, true)}
            />
            <Button size="sm" onClick={() => requestSettings("forges")}>
              Forges
            </Button>
          </div>
        </div>
      </fieldset>
    );
  }
  return (
    <fieldset className="review-pr">
      <legend className="sr-only">{words.Noun}</legend>
      {checking && !status ? (
        <span className="review-pr-state" role="status">
          <span className="spinner" aria-hidden="true" />
          Checking for a {words.noun}
        </span>
      ) : problem ? (
        <span className="review-pr-state is-problem" role="alert" title={problem}>
          <Icon name="alert" size={13} />
          <span>{problem}</span>
        </span>
      ) : pullRequest ? (
        <span className="review-pr-state">
          {status?.forge ? (
            <ConnectorLogo id={words.kind} title={words.label} size={14} />
          ) : (
            <Icon name="pullRequest" size={13} />
          )}
          <span className="review-pr-number">
            {words.sign}
            {pullRequest.number}
          </span>
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
          {pullRequest.state === "OPEN" && pullRequest.autoMerge ? (
            <Badge tone="info" dot>
              Auto-merge is on
            </Badge>
          ) : null}
        </span>
      ) : (
        <span className="review-pr-state">
          {status?.forge ? (
            <ConnectorLogo id={words.kind} title={words.label} size={14} />
          ) : (
            <Icon name="pullRequest" size={13} />
          )}
          <span>No {words.noun} for this branch yet</span>
        </span>
      )}
      {pullRequest ? (
        <>
          <IconButton
            label={
              copyState === "copied"
                ? "Link copied"
                : copyState === "failed"
                  ? "Copy failed"
                  : `Copy ${words.noun} link`
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
            View {words.short}
          </Button>
          {pullRequest.state === "OPEN" && capabilities.reviewThreads ? (
            <Button
              variant="ghost"
              size="sm"
              icon="message"
              aria-expanded={commentsOpen}
              onClick={() => setCommentsOpen((open) => !open)}
            >
              Review comments
            </Button>
          ) : null}
          {pullRequest.state === "OPEN" && capabilities.review ? (
            <Button size="sm" icon="check" onClick={() => setReviewOpen(true)}>
              Review
            </Button>
          ) : null}
          {pullRequest.state === "OPEN" && pullRequest.autoMerge && capabilities.autoMerge ? (
            <Button
              variant="ghost"
              size="sm"
              aria-label="Turn off auto-merge"
              tooltip="Turn off auto-merge"
              loading={turningOff}
              onClick={() => void turnOffAutoMerge()}
            >
              Turn off
            </Button>
          ) : null}
          {pullRequest.state === "OPEN" && !pullRequest.isDraft ? (
            <Button size="sm" icon="merge" onClick={() => setMergeOpen(true)}>
              Merge {words.short}
            </Button>
          ) : null}
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
          Create {words.short}
        </Button>
      ) : null}
      {pullRequest?.checks && capabilities.checks ? (
        <PullRequestChecks worktree={worktree} pullRequest={pullRequest} onShowAgent={onShowAgent} />
      ) : null}
      {commentsOpen && pullRequest?.state === "OPEN" && capabilities.reviewThreads ? (
        <PullRequestComments key={worktreeId} worktree={worktree} checkKey={checkKey} onShowAgent={onShowAgent} />
      ) : null}
      {mergeOpen && pullRequest?.state === "OPEN" ? (
        <Suspense fallback={null}>
          <MergePullRequestDialog
            worktree={worktree}
            pullRequest={pullRequest}
            forge={status?.forge}
            onClose={() => setMergeOpen(false)}
            onMerged={(result) => {
              setMergeOpen(false);
              recordPullRequest(worktreeId, result.pullRequest);
              onMerged?.(result);
            }}
            onAutoMerge={(result) => {
              setMergeOpen(false);
              updated(result);
            }}
          />
        </Suspense>
      ) : null}
      {reviewOpen && pullRequest?.state === "OPEN" ? (
        <Suspense fallback={null}>
          <ReviewPullRequestDialog
            worktree={worktree}
            pullRequest={pullRequest}
            onClose={() => setReviewOpen(false)}
            onReviewed={(result) => {
              setReviewOpen(false);
              updated(result);
            }}
          />
        </Suspense>
      ) : null}
      {dialogOpen ? (
        <Suspense fallback={null}>
          <PullRequestDialog
            worktree={worktree}
            base={base}
            forge={status?.forge}
            reloadKey={reviewedAt}
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
