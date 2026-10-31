import type { GitBranchesResult, ReviewProjection, WorktreeProjection } from "@zli-v2/contracts";
import { type FocusEvent, type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { BranchMenu } from "../review/BranchMenu.js";
import { trackDescription, trackText, useBranches } from "../review/branches.js";
import { changeTotals, stageStateOf } from "../review/changes.js";
import { pushBranch } from "../review/pullRequestClient.js";
import { refreshPullRequest } from "../review/pullRequestStore.js";
import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";

/** Git answers a commit or a first read through the projection; past this the popover stops waiting. */
export const GIT_ANSWER_TIMEOUT_MS = 60_000;
const EDGE = 8;
const GAP = 6;

export type CommitPlan =
  | { kind: "commit"; push: boolean; staged: boolean }
  | { kind: "push"; reason: string }
  | { kind: "none"; reason: string; push: boolean };

/** The one Git action the popover offers, given the worktree's changes and branches. */
export function commitPlan(review: ReviewProjection | undefined, branches: GitBranchesResult | undefined): CommitPlan {
  // Until the branches are read, origin is assumed; a failed push says why.
  const origin = !branches || branches.remote.length > 0 || !!branches.defaultBranch;
  if (!review) return { kind: "none", reason: "Reading the changes.", push: origin };
  if (review.state === "conflicted") {
    return { kind: "none", reason: "Finish or abort the merge in Changes first.", push: origin };
  }
  const states = review.files.map(stageStateOf);
  const current = branches?.current;
  if (states.some((state) => state !== "committed")) {
    return {
      kind: "commit",
      push: origin && (!branches || !!current),
      staged: states.some((state) => state === "staged" || state === "partial"),
    };
  }
  const upstream = current ? branches?.details?.[current]?.upstream : undefined;
  if (branches && origin && current) {
    if (upstream && !upstream.gone && upstream.ahead > 0) {
      return { kind: "push", reason: trackDescription(upstream) ?? "Commits are waiting to be pushed." };
    }
    if (!upstream && !branches.remote.includes(current)) {
      return { kind: "push", reason: `${current} is not on origin yet.` };
    }
  }
  return { kind: "none", reason: "No changes to commit.", push: origin };
}

/** A long path keeps its last folders, which tell worktrees apart. */
export function shortPath(path: string, max = 34): string {
  if (path.length <= max) return path;
  const parts = path.split(/[\\/]/u);
  const separator = path.includes("\\") ? "\\" : "/";
  let tail = parts.pop() ?? "";
  while (parts.length > 0 && tail.length + (parts.at(-1)?.length ?? 0) + 2 <= max)
    tail = `${parts.pop()}${separator}${tail}`;
  return `…${separator}${tail.length > max - 2 ? tail.slice(-(max - 2)) : tail}`;
}

type Placement = { left: number; top: number; maxHeight: number };

/**
 * The tile's Environment button: where the agent works, its changes, its branch, and one Git action to
 * commit and push. Git work keeps going when the popover closes, and its result shows when it opens again.
 */
export function EnvironmentButton({
  worktree,
  review,
  noGit,
  onOpenChanges,
}: {
  worktree: WorktreeProjection;
  review: ReviewProjection | undefined;
  /** The project folder is not a Git repository. */
  noGit: boolean;
  onOpenChanges(): void;
}) {
  const { dispatch } = useRuntime();
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement>();
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [phase, setPhase] = useState<"committing" | "pushing">();
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const commitRef = useRef<{ since: string | undefined; push: boolean; timer: number }>(undefined);
  const branchState = useBranches(dispatch, worktree.worktreeId, (open || branchMenuOpen) && !noGit);
  const branches = branchState.branches;
  const worktreeId = worktree.worktreeId;
  const hasReview = !!review;

  const close = (returnFocus: boolean) => {
    setOpen(false);
    setPlacement(undefined);
    if (returnFocus) triggerRef.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = triggerRef.current?.getBoundingClientRect();
    const popover = popoverRef.current;
    if (!anchor || !popover) return;
    const width = popover.offsetWidth;
    setPlacement({
      left: Math.max(EDGE, Math.min(anchor.right - width, window.innerWidth - width - EDGE)),
      top: anchor.bottom + GAP,
      maxHeight: Math.max(160, window.innerHeight - anchor.bottom - GAP - EDGE),
    });
  }, [open]);

  // The popover is measured while hidden, and hidden elements cannot take focus, so focus waits for placement.
  const placed = placement !== undefined;
  useLayoutEffect(() => {
    if (placed) popoverRef.current?.querySelector<HTMLElement>("button, input")?.focus({ preventScroll: true });
  }, [placed]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: close only sets state and reads refs, so opening is the only change.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
    };
    const onLeave = () => close(false);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", onLeave);
    window.addEventListener("blur", onLeave);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", onLeave);
      window.removeEventListener("blur", onLeave);
    };
  }, [open]);

  // Opening the popover reads the uncommitted changes when nothing has read this worktree's changes yet.
  useEffect(() => {
    if (!open || noGit || hasReview) return;
    let live = true;
    setReading(true);
    const timer = window.setTimeout(() => {
      if (!live) return;
      setReading(false);
      setError("The changes could not be read. Open Changes to try again.");
    }, GIT_ANSWER_TIMEOUT_MS);
    const fail = (text: string) => {
      if (!live) return;
      window.clearTimeout(timer);
      setReading(false);
      setError(text);
    };
    dispatch({
      protocolVersion: 1,
      commandId: makeCommandId(),
      command: { type: "review.refresh", worktreeId, baseRef: "HEAD" },
    }).then(
      (response) => {
        if (!response) fail("The runtime is not connected.");
        else if (response.accepted === false) fail(response.error.message);
      },
      (cause: unknown) => fail(cause instanceof Error ? cause.message : "The changes could not be read."),
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [open, noGit, hasReview, worktreeId, dispatch]);

  useEffect(() => {
    if (hasReview) setReading(false);
  }, [hasReview]);

  useEffect(
    () => () => {
      if (commitRef.current) window.clearTimeout(commitRef.current.timer);
    },
    [],
  );

  const push = async (afterCommit: boolean) => {
    setPhase("pushing");
    try {
      const result = await pushBranch(dispatch, worktreeId);
      setNotice(
        afterCommit ? `Committed and pushed ${result.branch} to origin.` : `Pushed ${result.branch} to origin.`,
      );
      void refreshPullRequest(dispatch, worktreeId, true);
      void branchState.reload();
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : "The push failed.";
      setError(afterCommit ? `Committed, but the push failed. ${reason}` : reason);
    } finally {
      setPhase(undefined);
    }
  };

  // The commit is done when Git sends back a new review for this worktree.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new review can finish a commit.
  useEffect(() => {
    const pending = commitRef.current;
    if (!pending || !review || review.updatedAt === pending.since) return;
    window.clearTimeout(pending.timer);
    commitRef.current = undefined;
    if (review.errorMessage) {
      setError(review.errorMessage);
      setPhase(undefined);
      return;
    }
    setMessage("");
    if (pending.push) void push(true);
    else {
      setNotice(`Committed to ${branches?.current ?? worktree.branch}.`);
      setPhase(undefined);
    }
  }, [review]);

  const plan = commitPlan(review, branches);
  const files = review?.files ?? [];
  const totals = changeTotals(files);

  const runAction = async () => {
    if (phase) return;
    setError(undefined);
    setNotice(undefined);
    if (plan.kind === "push") {
      await push(false);
      return;
    }
    const text = message.trim();
    if (plan.kind !== "commit" || !text) return;
    setPhase("committing");
    const timer = window.setTimeout(() => {
      if (!commitRef.current) return;
      commitRef.current = undefined;
      setPhase(undefined);
      setError("Git has not answered the commit yet. Open Changes to see where it stands.");
    }, GIT_ANSWER_TIMEOUT_MS);
    commitRef.current = { since: review?.updatedAt, push: plan.push, timer };
    const failed = (reason: string) => {
      window.clearTimeout(timer);
      commitRef.current = undefined;
      setPhase(undefined);
      setError(reason);
    };
    try {
      const response = await dispatch({
        protocolVersion: 1,
        commandId: makeCommandId(),
        command: { type: "review.commit", worktreeId, message: text },
      });
      if (!response) failed("The runtime is not connected.");
      else if (response.accepted === false) failed(response.error.message);
    } catch (cause) {
      failed(cause instanceof Error ? cause.message : "The commit failed.");
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  };

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && !popoverRef.current?.contains(next) && !triggerRef.current?.contains(next))
      close(false);
  };

  const local = worktree.kind === "checkout";
  const branchName = branches?.current ?? worktree.branch;
  const upstream = branches?.current ? branches.details?.[branches.current]?.upstream : undefined;
  const track = upstream?.gone ? "" : trackText(upstream);
  const actionLabel =
    phase === "committing"
      ? "Committing"
      : phase === "pushing"
        ? "Pushing"
        : plan.kind === "push"
          ? "Push"
          : !plan.push
            ? "Commit"
            : "Commit and push";
  const hint =
    plan.kind === "commit"
      ? `${plan.staged ? "Commits only the staged changes" : "Commits every change, new files included"}${
          plan.push ? ", then pushes the branch to origin." : ". There is no origin to push to."
        }`
      : plan.reason;

  return (
    <>
      <IconButton
        ref={triggerRef}
        label="Environment"
        tooltip="Environment: folder, changes, and branch"
        icon="monitor"
        size="sm"
        iconSize={13}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close(false) : setOpen(true))}
      />
      {open
        ? createPortal(
            <div
              ref={popoverRef}
              className="popover env-popover"
              role="dialog"
              aria-label="Environment"
              style={placement ?? { left: 0, top: 0, visibility: "hidden" }}
              onKeyDown={onKeyDown}
              onBlur={onBlur}
            >
              <p className="popover-title">Environment</p>
              <div className="env-row" title={worktree.path}>
                <Icon name={local ? "monitor" : "folderTree"} size={14} />
                <span className="env-row-text">
                  <span className="env-row-label">{local ? "Local" : "Worktree"}</span>
                  <span className="env-row-detail">{shortPath(worktree.path)}</span>
                </span>
              </div>
              {noGit ? (
                <p className="env-line">This folder is not a Git repository, so it has no changes or branches.</p>
              ) : (
                <>
                  <button
                    type="button"
                    className="env-row is-action"
                    title={
                      review && review.baseRef !== "HEAD"
                        ? `Changes against ${review.baseRef}. Opens Changes.`
                        : "Uncommitted changes. Opens Changes."
                    }
                    onClick={() => {
                      close(false);
                      onOpenChanges();
                    }}
                  >
                    <Icon name="diff" size={14} />
                    <span className="env-row-label">Changes</span>
                    <span className="env-row-end">
                      {!review ? (
                        reading ? (
                          <>
                            <span className="spinner" aria-hidden="true" />
                            Reading
                          </>
                        ) : null
                      ) : files.length === 0 ? (
                        "None"
                      ) : (
                        <>
                          <span className="env-add">+{totals.additions.toLocaleString("en-US")}</span>
                          <span className="env-del">−{totals.deletions.toLocaleString("en-US")}</span>
                        </>
                      )}
                    </span>
                    <Icon name="chevronRight" size={13} />
                  </button>
                  <button
                    type="button"
                    className="env-row is-action"
                    aria-haspopup="dialog"
                    aria-label={`Branch ${branchName}`}
                    title="Switch, create, rename, or delete branches"
                    onClick={() => {
                      close(false);
                      setBranchMenuOpen(true);
                    }}
                  >
                    <Icon name="branch" size={14} />
                    <span className="env-row-label is-mono">{branchName}</span>
                    {track ? (
                      <span className="env-row-end" title={trackDescription(upstream)}>
                        {track}
                      </span>
                    ) : null}
                    <Icon name="chevronDown" size={13} />
                  </button>
                  <div className="env-commit">
                    {plan.kind === "commit" ? (
                      <input
                        className="input input-sm"
                        aria-label="Commit message"
                        placeholder="Commit message"
                        value={message}
                        disabled={!!phase}
                        onChange={(event) => setMessage(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" || !message.trim()) return;
                          event.preventDefault();
                          void runAction();
                        }}
                      />
                    ) : null}
                    <Button
                      variant={plan.kind === "none" ? "secondary" : "primary"}
                      size="sm"
                      icon={plan.kind === "push" ? "upload" : "commit"}
                      loading={!!phase}
                      disabled={plan.kind === "none" || (plan.kind === "commit" && !message.trim())}
                      onClick={() => void runAction()}
                    >
                      {actionLabel}
                    </Button>
                  </div>
                  {error ? (
                    <p className="inline-error env-line" role="alert">
                      <Icon name="alert" size={13} />
                      <span>{error}</span>
                    </p>
                  ) : notice ? (
                    <p className="env-line is-done" role="status">
                      <Icon name="check" size={13} />
                      <span>{notice}</span>
                    </p>
                  ) : (
                    <p className="env-line">{hint}</p>
                  )}
                </>
              )}
            </div>,
            document.body,
          )
        : null}
      {branchMenuOpen ? (
        <BranchMenu
          worktree={worktree}
          branches={branches}
          onClose={() => {
            setBranchMenuOpen(false);
            triggerRef.current?.focus();
          }}
          onChanged={(result, text, done) => {
            branchState.apply(result);
            setError(undefined);
            setNotice(text);
            if (done) {
              setBranchMenuOpen(false);
              triggerRef.current?.focus();
            }
            if (review) {
              void dispatch({
                protocolVersion: 1,
                commandId: makeCommandId(),
                command: { type: "review.refresh", worktreeId, baseRef: review.baseRef },
              }).catch(() => undefined);
            }
            void refreshPullRequest(dispatch, worktreeId, true);
          }}
        />
      ) : null}
    </>
  );
}
