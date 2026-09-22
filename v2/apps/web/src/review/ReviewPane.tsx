import { useMemo, useState } from "react";

import type { WorktreeProjection } from "@zli-v2/contracts";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { makeCommandId } from "../runtime/commandId.js";

export function ReviewPane({ worktree }: { worktree: WorktreeProjection | undefined }) {
  const { dispatch, projection } = useRuntime();
  const [baseRef, setBaseRef] = useState("main");
  const [targetRef, setTargetRef] = useState("main");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const review = projection?.reviews?.find((candidate) => candidate.worktreeId === worktree?.worktreeId);
  const fileCount = useMemo(() => review?.files.length ?? 0, [review]);

  const run = async (command: unknown) => {
    setBusy(true);
    setError(undefined);
    try {
      const response = await dispatch({ protocolVersion: 1, commandId: makeCommandId(), command });
      if (response?.accepted === false) setError(response.error.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The review operation failed.");
    } finally {
      setBusy(false);
    }
  };

  const loadDiff = (path: string) => run({ type: "review.diff", worktreeId: worktree?.worktreeId, path });

  return (
    <div className="tool-pane review-pane">
      <div className="tool-pane-header">
        <div>
          <span className="eyebrow">Review</span>
          <h2>{worktree?.branch ?? "No worktree selected"}</h2>
        </div>
        <span className="pane-meta">{review ? `${fileCount} file${fileCount === 1 ? "" : "s"}` : "Git"}</span>
      </div>
      {!worktree ? (
        <div className="empty-pane">
          <p className="empty-title">Select a worktree</p>
          <p className="empty-detail">Changes and merge actions are scoped to the selected worktree.</p>
        </div>
      ) : !review ? (
        <div className="empty-pane">
          <p className="empty-title">No review loaded</p>
          <p className="empty-detail">Refresh this worktree to load real staged and unstaged changes from Git.</p>
        </div>
      ) : (
        <div className="review-file-list">
          {review.files.map((file) => (
            <button
              className={`review-file${review.diff?.path === file.path ? " is-selected" : ""}`}
              key={file.path}
              type="button"
              onClick={() => void loadDiff(file.path)}
              aria-pressed={review.diff?.path === file.path}
            >
              <span className={`status-dot status-${file.kind}`} aria-hidden="true" />
              <span className="review-file-name" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
                {file.oldPath ? (
                  <>
                    {file.oldPath}
                    <span className="rename-arrow" aria-hidden="true">
                      →
                    </span>
                    {file.path}
                  </>
                ) : (
                  file.path
                )}
              </span>
              <span className="file-stat">{file.binary ? "binary" : `+${file.additions} −${file.deletions}`}</span>
            </button>
          ))}
        </div>
      )}
      {review?.diff && (
        <section className="review-diff-panel" aria-label={`Diff for ${review.diff.path}`}>
          <div className="review-diff-header">
            <span>{review.diff.binary ? "Binary file" : "File diff"}</span>
            <span>{review.diff.truncated ? "Output truncated" : "On demand"}</span>
          </div>
          <pre className="review-diff">{review.diff.patch || "No textual diff available for this file."}</pre>
        </section>
      )}
      {review?.errorMessage && (
        <p className="inline-error" role="alert">
          {review.errorMessage}
        </p>
      )}
      {worktree && (
        <div className="review-controls">
          <label>
            Compare against
            <input value={baseRef} onChange={(event) => setBaseRef(event.target.value)} placeholder="main" />
          </label>
          <button
            className="secondary-button"
            type="button"
            disabled={busy || !baseRef.trim()}
            onClick={() =>
              void run({ type: "review.refresh", worktreeId: worktree.worktreeId, baseRef: baseRef.trim() })
            }
          >
            {busy ? "Working" : "Refresh changes"}
          </button>
          {review && (
            <>
              <div className="review-summary">
                {review.state === "conflicted"
                  ? `${review.conflictFiles.length} conflict${review.conflictFiles.length === 1 ? "" : "s"} need attention.`
                  : review.files.length === 0
                    ? "Working tree is clean."
                    : `${review.files.length} changed file${review.files.length === 1 ? "" : "s"}.`}
              </div>
              <label>
                Commit message
                <input
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder="Describe the change"
                />
              </label>
              <button
                className="primary-button"
                type="button"
                disabled={busy || !message.trim() || review.state === "conflicted"}
                onClick={() =>
                  void run({ type: "review.commit", worktreeId: worktree.worktreeId, message: message.trim() })
                }
              >
                Commit changes
              </button>
              <label>
                Merge target
                <input value={targetRef} onChange={(event) => setTargetRef(event.target.value)} placeholder="main" />
              </label>
              <button
                className="secondary-button"
                type="button"
                disabled={busy || !targetRef.trim() || review.state === "conflicted"}
                onClick={() =>
                  void run({ type: "review.merge", worktreeId: worktree.worktreeId, targetRef: targetRef.trim() })
                }
              >
                Merge into target
              </button>
              {(review.state === "conflicted" || review.errorMessage) && (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy}
                  onClick={() => void run({ type: "review.abortMerge", worktreeId: worktree.worktreeId })}
                >
                  Abort merge
                </button>
              )}
            </>
          )}
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
