import type { RuntimeProjection, WorktreeProjection } from "@zli-v2/contracts";
import { useEffect, useMemo, useState } from "react";

import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime, useRuntimeSelector } from "../runtime/RuntimeProvider.js";
import { Button } from "../ui/Button.js";
import { EmptyState, LoadingState } from "../ui/Pane.js";
import { changeTotals, stageStateOf } from "./changes.js";
import { DiffView } from "./DiffView.js";
import { FilePath, kindLetter, ReviewDiffHeader } from "./ReviewPane.js";

import "./review.css";

const selectReviews = (projection: RuntimeProjection | undefined) => projection?.reviews;

/**
 * The pull request's Code tab: the files its branch changes against the base, and a file's diff in the list's
 * place. Staging and committing stay in Changes, one click away.
 */
export function PullRequestCode({
  worktree,
  baseRefName,
  onOpenChanges,
}: {
  worktree: WorktreeProjection;
  /** The branch the pull request merges into, as GitHub names it. */
  baseRefName: string | undefined;
  onOpenChanges(): void;
}) {
  const { dispatch } = useRuntime();
  const review = useRuntimeSelector(selectReviews)?.find((entry) => entry.worktreeId === worktree.worktreeId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [openPath, setOpenPath] = useState<string>();
  const totals = useMemo(() => changeTotals(review?.files ?? []), [review]);
  const local = useMemo(() => (review?.files ?? []).some((file) => stageStateOf(file) !== "committed"), [review]);

  const run = async (command: Record<string, unknown>): Promise<string | undefined> => {
    try {
      const response = await dispatch({ protocolVersion: 1, commandId: makeCommandId(), command });
      return response?.accepted === false ? response.error.message : undefined;
    } catch (cause) {
      return cause instanceof Error ? cause.message : "Could not read the changes.";
    }
  };

  // Compare with origin's copy of the base first, since that is what the pull request merges into.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new worktree or base reads the files again.
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(undefined);
    setOpenPath(undefined);
    const base = baseRefName ?? "main";
    void (async () => {
      let failure = await run({ type: "review.refresh", worktreeId: worktree.worktreeId, baseRef: `origin/${base}` });
      if (failure) failure = await run({ type: "review.refresh", worktreeId: worktree.worktreeId, baseRef: base });
      if (!current) return;
      setError(failure);
      setLoading(false);
    })();
    return () => {
      current = false;
    };
  }, [worktree.worktreeId, baseRefName]);

  const openFile = async (path: string) => {
    setOpenPath(path);
    setError(undefined);
    const failure = await run({ type: "review.diff", worktreeId: worktree.worktreeId, path });
    if (failure) setError(failure);
  };

  if (loading && !review) return <LoadingState label={`Reading the changes on ${worktree.branch}`} />;
  if (error && !review) {
    return (
      <EmptyState icon="alert" tone="danger" title="Could not read the changes" detail={error}>
        <Button size="sm" icon="diff" onClick={onOpenChanges}>
          Open Changes
        </Button>
      </EmptyState>
    );
  }
  if (!review || review.files.length === 0) {
    return (
      <EmptyState
        icon="diff"
        title="No changes against the base"
        detail={`${worktree.branch} matches ${review?.baseRef ?? baseRefName ?? "its base"}.`}
      />
    );
  }

  const files = review.files;
  const diff = openPath && review.diff?.path === openPath ? review.diff : undefined;

  if (openPath) {
    return (
      <div className="pr-code is-reading">
        <ReviewDiffHeader
          files={files}
          path={openPath}
          onBack={() => setOpenPath(undefined)}
          onOpen={(path) => void openFile(path)}
        />
        {error ? (
          <p className="inline-error pr-code-error" role="alert">
            {error}
          </p>
        ) : diff ? (
          <div className="pr-code-diff">
            <DiffView worktreeId={worktree.worktreeId} diff={diff} />
          </div>
        ) : (
          <LoadingState label={`Loading ${openPath}`} />
        )}
      </div>
    );
  }

  return (
    <div className="pr-code">
      <div className="pr-code-head">
        <span className="pr-code-summary">
          {files.length} {files.length === 1 ? "file" : "files"}
          <span className="diff-add">+{totals.additions}</span>
          <span className="diff-del">−{totals.deletions}</span>
          <span className="pr-code-base">
            against <span className="is-mono">{review.baseRef}</span>
          </span>
        </span>
        {loading ? <span className="spinner" role="status" aria-label="Refreshing the changes" /> : null}
        <Button size="sm" variant="ghost" icon="diff" onClick={onOpenChanges}>
          Open in Changes
        </Button>
      </div>
      {local ? <p className="pr-code-note">Includes changes in the worktree that are not pushed yet.</p> : null}
      {error ? (
        <p className="inline-error pr-code-error" role="alert">
          {error}
        </p>
      ) : null}
      <ul className="pr-code-files">
        {files.map((file) => (
          <li key={file.path} className="review-file-row">
            <button type="button" className="review-file" onClick={() => void openFile(file.path)}>
              <span className="review-file-name" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
                <FilePath path={file.path} renamedFrom={file.oldPath} />
              </span>
              <span className="file-stat">
                {file.binary ? (
                  "binary"
                ) : (
                  <>
                    <span className="diff-add">+{file.additions}</span>
                    <span className="diff-del">−{file.deletions}</span>
                  </>
                )}
              </span>
              <span className={`file-kind file-kind-${file.kind}`} title={file.kind} aria-hidden="true">
                {kindLetter(file.kind)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
