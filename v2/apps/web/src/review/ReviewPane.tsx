import type { RuntimeProjection, WorktreeProjection } from "@zli-v2/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime, useRuntimeSelector } from "../runtime/RuntimeProvider.js";
import type { SessionMode } from "../sessions/sessions.js";
import { Button } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { EmptyState, PaneHeader } from "../ui/Pane.js";
import { DiffView } from "./DiffView.js";
import { PullRequestSection } from "./PullRequestSection.js";
import { ReviewCommentList } from "./ReviewCommentList.js";
import "./review.css";

export type ReviewFocus = { path: string; nonce: number };

/** Paths from agent tool calls can be absolute; review paths are relative to the worktree. */
export function worktreeRelativePath(root: string, path: string): string {
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/u, "");
  const base = normalize(root);
  const target = normalize(path);
  if (target.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return target.slice(base.length + 1);
  return target.replace(/^\.\//u, "");
}

const selectReviews = (projection: RuntimeProjection | undefined) => projection?.reviews;
const selectProjects = (projection: RuntimeProjection | undefined) => projection?.projects;

export function ReviewPane({
  worktree,
  focus,
  onShowAgent,
}: {
  worktree: WorktreeProjection | undefined;
  /** A file to open, for example from a changed-files card. The nonce reopens the same path. */
  focus?: ReviewFocus | undefined;
  /** Brings an agent's tile forward in the given view, after review comments are sent to it. */
  onShowAgent?(sessionId: string, mode: SessionMode): void;
}) {
  const { dispatch } = useRuntime();
  const reviews = useRuntimeSelector(selectReviews);
  const noGit = useRuntimeSelector(selectProjects)?.some(
    (project) => project.projectId === worktree?.projectId && project.git === false,
  );
  const [baseRef, setBaseRef] = useState("main");
  const [targetRef, setTargetRef] = useState("main");
  const [targetTouched, setTargetTouched] = useState(false);
  const [prCheckKey, setPrCheckKey] = useState(0);
  const commitRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const review = reviews?.find((candidate) => candidate.worktreeId === worktree?.worktreeId);
  const totals = useMemo(
    () =>
      (review?.files ?? []).reduce(
        (sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }),
        { additions: 0, deletions: 0 },
      ),
    [review],
  );
  const fileCount = review?.files.length ?? 0;

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new focus request should load a diff.
  useEffect(() => {
    if (!focus || !worktree || noGit) return;
    const path = worktreeRelativePath(worktree.path, focus.path);
    void (async () => {
      if (!review?.files.some((file) => file.path === path)) {
        await run({ type: "review.refresh", worktreeId: worktree.worktreeId, baseRef: baseRef.trim() || "HEAD" });
      }
      await run({ type: "review.diff", worktreeId: worktree.worktreeId, path });
    })();
  }, [focus?.nonce, worktree?.worktreeId]);
  const refresh = () => {
    if (!worktree || !baseRef.trim()) return;
    setPrCheckKey((key) => key + 1);
    void run({ type: "review.refresh", worktreeId: worktree.worktreeId, baseRef: baseRef.trim() });
  };

  return (
    <div className="tool-pane review-pane">
      <PaneHeader icon="diff" title="Changes" detail={worktree?.branch}>
        {review && fileCount > 0 ? (
          <span className="review-totals">
            <span className="diff-add">+{totals.additions}</span>
            <span className="diff-del">−{totals.deletions}</span>
          </span>
        ) : null}
      </PaneHeader>
      {worktree && !noGit ? (
        <form
          className="toolbar review-toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            refresh();
          }}
        >
          <label className="inline-field">
            <span>Compare against</span>
            <input
              className="input input-sm is-mono"
              value={baseRef}
              onChange={(event) => setBaseRef(event.target.value)}
              placeholder="main"
              spellCheck={false}
            />
          </label>
          <Button variant="ghost" size="sm" type="submit" icon="reload" loading={busy} disabled={!baseRef.trim()}>
            Refresh changes
          </Button>
        </form>
      ) : null}
      {!worktree ? (
        <EmptyState
          icon="diff"
          title="Select a worktree"
          detail="Changes and merge actions are scoped to the selected worktree."
        />
      ) : noGit ? (
        <EmptyState
          icon="diff"
          title="This folder is not a Git repository"
          detail="Changes, commits, and merges need Git. Run git init in the folder to use them."
        />
      ) : !review ? (
        <EmptyState
          icon="diff"
          title="Changes not loaded yet"
          detail="Choose a branch to compare against, then refresh to see staged and unstaged changes."
        />
      ) : (
        <div className="review-body">
          <div className="review-summary" role="status">
            {review.state === "conflicted"
              ? `${review.conflictFiles.length} conflict${review.conflictFiles.length === 1 ? "" : "s"} need attention.`
              : review.files.length === 0
                ? "Working tree is clean."
                : `${review.files.length} changed file${review.files.length === 1 ? "" : "s"}`}
          </div>
          {review.files.length > 0 ? (
            <div className="review-file-list">
              {review.files.map((file) => (
                <button
                  className={`review-file${review.diff?.path === file.path ? " is-selected" : ""}`}
                  key={file.path}
                  type="button"
                  onClick={() => void loadDiff(file.path)}
                  aria-pressed={review.diff?.path === file.path}
                >
                  <span className={`file-kind file-kind-${file.kind}`} title={file.kind} aria-hidden="true">
                    {kindLetter(file.kind)}
                  </span>
                  <span
                    className="review-file-name"
                    title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                  >
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
                </button>
              ))}
            </div>
          ) : null}
          {review.diff ? (
            <DiffView worktreeId={worktree.worktreeId} diff={review.diff} />
          ) : review.files.length > 0 ? (
            <p className="review-hint">Select a file to see its diff.</p>
          ) : null}
        </div>
      )}
      {worktree && review ? (
        <ReviewCommentList worktree={worktree} onOpenFile={(path) => void loadDiff(path)} onShowAgent={onShowAgent} />
      ) : null}
      {review?.errorMessage && (
        <p className="inline-error" role="alert">
          <Icon name="alert" size={13} />
          <span>{review.errorMessage}</span>
        </p>
      )}
      {worktree && review ? (
        <div className="review-actions">
          <div className="review-commit">
            <input
              ref={commitRef}
              className="input input-sm"
              aria-label="Commit message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Commit message"
              onKeyDown={(event) => {
                if (event.key === "Enter" && message.trim() && !busy && review.state !== "conflicted") {
                  event.preventDefault();
                  void run({ type: "review.commit", worktreeId: worktree.worktreeId, message: message.trim() });
                }
              }}
            />
            <Button
              variant="primary"
              size="sm"
              icon="commit"
              disabled={busy || !message.trim() || review.state === "conflicted"}
              onClick={() =>
                void run({ type: "review.commit", worktreeId: worktree.worktreeId, message: message.trim() })
              }
            >
              Commit changes
            </Button>
          </div>
          <div className="review-merge">
            <label className="inline-field">
              <span>Merge target</span>
              <input
                className="input input-sm is-mono"
                value={targetRef}
                onChange={(event) => {
                  setTargetRef(event.target.value);
                  setTargetTouched(true);
                }}
                placeholder="main"
                spellCheck={false}
              />
            </label>
            <Button
              size="sm"
              icon="merge"
              disabled={busy || !targetRef.trim() || review.state === "conflicted"}
              onClick={() =>
                void run({ type: "review.merge", worktreeId: worktree.worktreeId, targetRef: targetRef.trim() })
              }
            >
              Merge into target
            </Button>
            {(review.state === "conflicted" || review.errorMessage) && (
              <Button
                variant="ghost"
                size="sm"
                className="is-danger"
                disabled={busy}
                onClick={() => void run({ type: "review.abortMerge", worktreeId: worktree.worktreeId })}
              >
                Abort merge
              </Button>
            )}
          </div>
          <PullRequestSection
            worktree={worktree}
            base={targetTouched ? targetRef.trim() || undefined : undefined}
            checkKey={prCheckKey}
            onCommitFirst={() => commitRef.current?.focus()}
            onShowAgent={onShowAgent}
          />
        </div>
      ) : null}
      {error && (
        <p className="inline-error" role="alert">
          <Icon name="alert" size={13} />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

function kindLetter(kind: string): string {
  switch (kind) {
    case "added":
      return "A";
    case "untracked":
      return "U";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    default:
      return "M";
  }
}
