import type { ReviewProjection, WorktreeProjection } from "@zli-v2/contracts";
import { useEffect, useRef, useState } from "react";

import { changeTotals } from "../review/changes.js";
import { DiffView } from "../review/DiffView.js";
import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { Button } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { guestMergeCommand } from "./guestWork.js";

/** What the agent's chip menu asks of its card. */
export type GuestCardAction = "show" | "merge" | "discard";

type Outcome = { kind: "merged" } | { kind: "conflict"; files: readonly string[] } | { kind: "error"; text: string };

/**
 * What an agent brought in to work on a copy changed, compared with the chat's branch: its files, a diff of
 * each, and the way to merge them into the chat's branch or let the copy go.
 */
export function GuestWorkCard({
  name,
  hostBranch,
  worktree,
  review,
  working,
  onOpenChanges,
  onDiscard,
  ask,
}: {
  name: string;
  /** The chat's branch, which the copy is compared with and merges into. */
  hostBranch: string;
  /** The copy: the agent's own worktree. */
  worktree: WorktreeProjection;
  review: ReviewProjection | undefined;
  /** The agent is still at it, so merging waits. */
  working: boolean;
  /** Opens Changes for the chat's branch, where a conflicted merge is resolved. */
  onOpenChanges(): void;
  onDiscard?: (() => Promise<void>) | undefined;
  /** A request from the agent's chip menu; a new nonce asks again. */
  ask?: { action: GuestCardAction; nonce: number } | undefined;
}) {
  const { dispatch } = useRuntime();
  const [error, setError] = useState<string>();
  const [shown, setShown] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  // The review's time when the merge was asked for: the next review after it says how the merge went.
  const [mergedFrom, setMergedFrom] = useState<string | null>();
  const worktreeId = worktree.worktreeId;

  const run = async (command: Record<string, unknown>): Promise<boolean> => {
    setError(undefined);
    try {
      const response = await dispatch({ protocolVersion: 1, commandId: makeCommandId(), command });
      if (response?.accepted === false) {
        setError(response.error.message);
        return false;
      }
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not go through.");
      return false;
    }
  };

  // The copy is compared with the chat's branch, read again whenever the agent stops.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reads again only when the agent stops or the branch changes.
  useEffect(() => {
    if (working || worktree.status !== "ready") return;
    void run({ type: "review.refresh", worktreeId, baseRef: hostBranch });
  }, [working, worktreeId, hostBranch, worktree.status]);

  const files = review?.baseRef === hostBranch ? review.files : [];
  const totals = changeTotals(files);
  const outcome: Outcome | undefined =
    mergedFrom !== undefined && review && review.updatedAt !== mergedFrom
      ? review.state === "conflicted"
        ? { kind: "conflict", files: review.conflictFiles }
        : review.errorMessage
          ? { kind: "error", text: review.errorMessage }
          : { kind: "merged" }
      : undefined;
  const merging = mergedFrom !== undefined && !outcome;

  const merge = async () => {
    setMergedFrom(review?.updatedAt ?? null);
    const sent = await run(guestMergeCommand({ worktreeId, targetBranch: hostBranch, name }));
    if (!sent) setMergedFrom(undefined);
  };

  const showDiff = (path: string) => {
    if (shown === path) {
      setShown(undefined);
      return;
    }
    setShown(path);
    void run({ type: "review.diff", worktreeId, path });
  };

  const discard = async () => {
    if (!onDiscard) return;
    setDiscarding(true);
    try {
      await onDiscard();
    } finally {
      setDiscarding(false);
      setConfirming(false);
    }
  };

  const cardRef = useRef<HTMLElement>(null);
  const askNonce = ask?.nonce;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new request from the chip acts.
  useEffect(() => {
    if (!ask) return;
    cardRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    if (ask.action === "merge" && !working && files.length > 0 && !merging) void merge();
    if (ask.action === "discard" && onDiscard) setConfirming(true);
  }, [askNonce]);

  const diff = shown && review?.diff?.path === shown ? review.diff : undefined;
  return (
    <section className="guest-work" aria-label={`${name}'s copy`} ref={cardRef}>
      <header className="guest-work-head">
        <Icon name="branch" size={13} />
        <span className="guest-work-title">{working ? `${name} is working on a copy` : `${name}'s changes`}</span>
        <code className="guest-work-branch">{worktree.branch}</code>
        {files.length > 0 ? (
          <span className="guest-work-totals">
            {files.length === 1 ? "1 file" : `${files.length} files`}
            <span className="is-add">+{totals.additions}</span>
            <span className="is-del">−{totals.deletions}</span>
          </span>
        ) : null}
      </header>
      {files.length > 0 ? (
        <ul className="guest-work-files">
          {files.map((file) => (
            <li key={file.path}>
              <button
                type="button"
                className="guest-work-file"
                aria-expanded={shown === file.path}
                onClick={() => showDiff(file.path)}
              >
                <Icon name={shown === file.path ? "chevronDown" : "chevronRight"} size={12} />
                <span className="guest-work-path">{file.path}</span>
                <span className="is-add">+{file.additions}</span>
                <span className="is-del">−{file.deletions}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : outcome?.kind !== "merged" ? (
        <p className="guest-work-note">
          {working ? `Nothing changed yet. ${name} works in its own folder.` : `No changes from ${hostBranch} yet.`}
        </p>
      ) : null}
      {diff ? <DiffView worktreeId={worktreeId} diff={diff} /> : null}
      {outcome?.kind === "merged" ? (
        <p className="guest-work-note is-done" role="status">
          <Icon name="check" size={12} />
          Merged into {hostBranch}.
        </p>
      ) : outcome?.kind === "conflict" ? (
        <div className="guest-work-note is-conflict" role="alert">
          <span>
            Merging hit conflicts in {outcome.files.length === 1 ? "1 file" : `${outcome.files.length} files`}:{" "}
            {outcome.files.join(", ")}
          </span>
          <Button size="xs" icon="diff" onClick={onOpenChanges}>
            Open Changes
          </Button>
        </div>
      ) : outcome?.kind === "error" || error ? (
        <p className="guest-work-note is-error" role="alert">
          {outcome?.kind === "error" ? outcome.text : error}
        </p>
      ) : null}
      <div className="guest-work-actions">
        {confirming ? (
          <>
            <span className="guest-work-confirm">Discard {name}'s copy and its branch? Its changes are lost.</span>
            <Button size="xs" variant="danger" loading={discarding} onClick={() => void discard()}>
              Discard
            </Button>
            <Button size="xs" variant="ghost" disabled={discarding} onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </>
        ) : (
          <>
            {outcome?.kind !== "merged" ? (
              <Button
                size="xs"
                variant="primary"
                icon="merge"
                loading={merging}
                disabled={working || files.length === 0 || outcome?.kind === "conflict"}
                tooltip={working ? `Wait for ${name} to finish` : undefined}
                onClick={() => void merge()}
              >
                Merge into my branch
              </Button>
            ) : null}
            {onDiscard ? (
              <Button size="xs" variant="ghost" icon="trash" onClick={() => setConfirming(true)}>
                {outcome?.kind === "merged" ? "Remove the copy" : "Discard"}
              </Button>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
