import type {
  GitBranchesResult,
  GitHunkAction,
  ReviewDiffProjection,
  ReviewFileProjection,
  RuntimeProjection,
  WorktreeProjection,
} from "@zli-v2/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime, useRuntimeSelector } from "../runtime/RuntimeProvider.js";
import type { SessionMode } from "../sessions/sessions.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { MenuButton, type MenuItem } from "../ui/Menu.js";
import { EmptyState, LoadingState, PaneHeader } from "../ui/Pane.js";
import { Picker } from "../ui/Picker.js";
import { Segmented } from "../ui/Segmented.js";
import { BranchMenu } from "./BranchMenu.js";
import { branchOptions, defaultBranchOf, trackDescription, useBranches } from "./branches.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { DiffView } from "./DiffView.js";
import { MergeBranchDialog } from "./MergeBranchDialog.js";
import { PullRequestSection } from "./PullRequestSection.js";
import { applyHunk, discardFile, pullBranch, pushBranch, stageFiles, unstageFiles } from "./pullRequestClient.js";
import { refreshPullRequest } from "./pullRequestStore.js";
import { ReviewCommentList } from "./ReviewCommentList.js";
import { StashSection } from "./StashSection.js";
import "./review.css";

type DiffPart = "unstaged" | "staged";
type StageState = "staged" | "unstaged" | "partial" | "committed";
type Discard =
  | { kind: "file"; file: ReviewFileProjection }
  | { kind: "hunk"; path: string; index: number; hunk: string };

/** Committed means the file differs from the base only through commits, so there is nothing to stage. */
export function stageStateOf(file: ReviewFileProjection): StageState {
  // Projections saved before staging existed lack `unstaged`; treat their files as unstaged until a refresh.
  const unstaged = file.unstaged ?? !file.staged;
  return file.staged && unstaged ? "partial" : file.staged ? "staged" : unstaged ? "unstaged" : "committed";
}

const stageTooltips: Record<Exclude<StageState, "committed">, string> = {
  staged: "Staged. Uncheck to unstage.",
  partial: "Partly staged. Check to stage the rest.",
  unstaged: "Not staged. Check to stage.",
};

function hunkCount(patch: string): number {
  return patch.split("\n").filter((line) => line.startsWith("@@ ")).length;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export type ReviewFocus = { path: string; nonce: number };

/** Paths from agent tool calls can be absolute; review paths are relative to the worktree. */
export function worktreeRelativePath(root: string, path: string): string {
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/u, "");
  const base = normalize(root);
  const target = normalize(path);
  if (target.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return target.slice(base.length + 1);
  return target.replace(/^\.\//u, "");
}

/** What the comparison starts against: the local default branch, or origin's copy when it is not checked out. */
export function compareDefaultOf(branches: GitBranchesResult): string | undefined {
  const name = defaultBranchOf(branches);
  if (!name || branches.local.includes(name) || !branches.remote.includes(name)) return name;
  return `origin/${name}`;
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
  const [baseTouched, setBaseTouched] = useState(false);
  const [targetRef, setTargetRef] = useState("main");
  const [targetTouched, setTargetTouched] = useState(false);
  const [prCheckKey, setPrCheckKey] = useState(0);
  const commitRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState<"pull" | "push">();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const autoLoaded = useRef<string | undefined>(undefined);
  const branchState = useBranches(dispatch, worktree?.worktreeId, !!worktree && !noGit);
  const branches = branchState.branches;
  const [changing, setChanging] = useState(false);
  const [diffPart, setDiffPart] = useState<DiffPart>("unstaged");
  const [discarding, setDiscarding] = useState<Discard>();
  /** The file whose diff was open before a Git change; a refresh drops the diff, so it is loaded again. */
  const reopenRef = useRef<string | undefined>(undefined);
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
  const stageStates = useMemo(() => (review?.files ?? []).map(stageStateOf), [review]);
  const stagedCount = stageStates.filter((state) => state === "staged" || state === "partial").length;
  const anyUnstaged = stageStates.some((state) => state === "unstaged" || state === "partial");
  const hasLocalChanges = stageStates.some((state) => state !== "committed");

  const run = async (command: unknown): Promise<boolean> => {
    setBusy(true);
    setError(undefined);
    try {
      const response = await dispatch({ protocolVersion: 1, commandId: makeCommandId(), command });
      if (response?.accepted === false) {
        setError(response.error.message);
        return false;
      }
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The review operation failed.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const loadDiff = (path: string) => run({ type: "review.diff", worktreeId: worktree?.worktreeId, path });

  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new review projection can finish a reopen.
  useEffect(() => {
    const path = reopenRef.current;
    if (!path || !review) return;
    if (review.diff) {
      if (review.errorMessage) reopenRef.current = undefined;
      return;
    }
    reopenRef.current = undefined;
    if (review.files.some((file) => file.path === path)) void loadDiff(path);
  }, [review]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a different file starts on its unstaged changes.
  useEffect(() => setDiffPart("unstaged"), [review?.diff?.path]);

  /** Runs a staging, discard, or stash action, then refreshes the review against the current base. */
  const change = async (action: () => Promise<unknown>, success?: string) => {
    if (!worktree) return;
    setChanging(true);
    setError(undefined);
    setNotice(undefined);
    let failure: string | undefined;
    try {
      await action();
    } catch (cause) {
      failure = cause instanceof Error ? cause.message : "The Git change failed.";
    }
    await refreshAfterChange();
    if (failure) setError(failure);
    else if (success) setNotice(success);
    setChanging(false);
  };

  const refreshAfterChange = async () => {
    if (!worktree) return;
    reopenRef.current = review?.diff?.path;
    await run({ type: "review.refresh", worktreeId: worktree.worktreeId, baseRef: baseRef.trim() || "HEAD" });
  };

  const toggleStage = (file: ReviewFileProjection, state: StageState) => {
    if (!worktree) return;
    const id = worktree.worktreeId;
    // A staged rename is only undone with both names; staging needs just the new one.
    void change(() =>
      state === "staged"
        ? unstageFiles(dispatch, id, file.oldPath ? [file.path, file.oldPath] : [file.path])
        : stageFiles(dispatch, id, [file.path]),
    );
  };

  const confirmDiscard = async (target: Discard) => {
    if (!worktree) return;
    const id = worktree.worktreeId;
    await change(
      () =>
        target.kind === "file"
          ? discardFile(dispatch, id, target.file.path)
          : applyHunk(dispatch, id, { path: target.path, action: "discard", index: target.index, hunk: target.hunk }),
      target.kind === "file" ? `Discarded the changes to ${target.file.path}.` : `Discarded a hunk in ${target.path}.`,
    );
    setDiscarding(undefined);
  };

  const onHunk = (path: string, action: GitHunkAction, index: number, hunk: string) => {
    if (!worktree) return;
    if (action === "discard") {
      setDiscarding({ kind: "hunk", path, index, hunk });
      return;
    }
    const id = worktree.worktreeId;
    void change(() => applyHunk(dispatch, id, { path, action, index, hunk }));
  };

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
  const refresh = (ref = baseRef) => {
    if (!worktree || !ref.trim()) return;
    setPrCheckKey((key) => key + 1);
    void run({ type: "review.refresh", worktreeId: worktree.worktreeId, baseRef: ref.trim() });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new worktree starts with fresh choices.
  useEffect(() => {
    setBaseTouched(false);
    setTargetTouched(false);
    setNotice(undefined);
    setError(undefined);
  }, [worktree?.worktreeId]);

  // Until the person picks a branch, both pickers follow the repository's default branch.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new branch list moves the defaults.
  useEffect(() => {
    if (!branches) return;
    const compare = compareDefaultOf(branches);
    const target = defaultBranchOf(branches);
    if (!baseTouched && compare) setBaseRef(compare);
    if (!targetTouched && target) setTargetRef(target);
  }, [branches]);

  const compareChoices = useMemo(
    () => branchOptions(branches, { remote: true, selected: baseRef }),
    [branches, baseRef],
  );
  const targetChoices = useMemo(() => branchOptions(branches, { selected: targetRef }), [branches, targetRef]);

  const sync = async (kind: "pull" | "push") => {
    if (!worktree) return;
    setSyncing(kind);
    setError(undefined);
    setNotice(undefined);
    try {
      if (kind === "pull") {
        const result = await pullBranch(dispatch, worktree.worktreeId);
        setNotice(
          result.commits === 0
            ? `${result.branch} is already up to date with origin.`
            : `Pulled ${result.commits} commit${result.commits === 1 ? "" : "s"} into ${result.branch}.`,
        );
        if (review) refresh();
      } else {
        const result = await pushBranch(dispatch, worktree.worktreeId);
        setNotice(`Pushed ${result.branch} to origin.`);
        void refreshPullRequest(dispatch, worktree.worktreeId, true);
      }
      void branchState.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `The ${kind} failed.`);
    } finally {
      setSyncing(undefined);
    }
  };

  const currentBranch = branches?.current ?? worktree?.branch;
  const upstream = branches?.current ? branches.details?.[branches.current]?.upstream : undefined;
  const toPull = upstream && !upstream.gone ? upstream.behind : 0;
  const toPush = upstream && !upstream.gone ? upstream.ahead : 0;

  const fetchOrigin = async () => {
    setNotice(undefined);
    if (await branchState.fetch()) setNotice("Fetched the latest branches from origin.");
  };

  const shownError = error ?? branchState.error;
  const conflicted = review?.state === "conflicted";

  // Opening the panel loads the changes once, without a click.
  // biome-ignore lint/correctness/useExhaustiveDependencies: loads once per worktree.
  useEffect(() => {
    if (!worktree || noGit) return;
    if (autoLoaded.current === worktree.worktreeId) return;
    autoLoaded.current = worktree.worktreeId;
    refresh();
  }, [worktree?.worktreeId, noGit]);

  const moreItems = (): MenuItem[] => [
    {
      label: "Merge into another branch…",
      icon: "merge",
      disabled: !review || conflicted,
      run: () => setMergeOpen(true),
    },
    ...(review && (conflicted || review.errorMessage)
      ? [
          {
            label: "Abort merge",
            icon: "x" as const,
            tone: "danger" as const,
            run: () => void run({ type: "review.abortMerge", worktreeId: worktree?.worktreeId }),
          },
        ]
      : []),
  ];
  return (
    <div className="tool-pane review-pane">
      <PaneHeader
        icon="diff"
        title="Changes"
        detail={
          worktree && !noGit ? (
            <button
              type="button"
              className="pane-detail-button"
              aria-haspopup="dialog"
              aria-label={currentBranch ? `Branch ${currentBranch}` : "Branches"}
              data-tooltip="Switch, create, rename, or delete branches"
              onClick={() => setBranchMenuOpen(true)}
            >
              <Icon name="branch" size={12} />
              <span>{currentBranch}</span>
              <Icon name="chevronDown" size={11} />
            </button>
          ) : (
            worktree?.branch
          )
        }
      >
        {review && fileCount > 0 ? (
          <span className="review-totals">
            <span className="diff-add">+{totals.additions}</span>
            <span className="diff-del">−{totals.deletions}</span>
          </span>
        ) : null}
        {worktree && !noGit ? (
          <>
            <IconButton
              label="Refresh changes"
              icon="reload"
              size="sm"
              className={busy ? "is-spinning" : undefined}
              disabled={busy || !baseRef.trim()}
              onClick={() => refresh()}
            />
            <MenuButton label="More Git actions" items={moreItems} />
          </>
        ) : null}
      </PaneHeader>
      {worktree && !noGit ? (
        <div className="toolbar review-toolbar">
          <span className="inline-field">
            <span aria-hidden="true">Compare against</span>
            <Picker
              variant="field"
              className="input-sm review-branch-picker"
              label="Compare against"
              value={baseRef}
              options={compareChoices}
              onChange={(next) => {
                setBaseRef(next);
                setBaseTouched(true);
                refresh(next);
              }}
            >
              <span className="picker-trigger-label">{baseRef}</span>
            </Picker>
          </span>
          <IconButton
            label="Fetch branches from origin"
            icon={branchState.loading === "fetch" ? "loader" : "rotate"}
            size="sm"
            disabled={branchState.loading === "fetch"}
            onClick={() => void fetchOrigin()}
          />
          <Button
            variant="ghost"
            size="sm"
            icon="download"
            aria-label={toPull > 0 ? `Pull, ${toPull} to pull` : undefined}
            loading={syncing === "pull"}
            disabled={!!syncing}
            tooltip={
              toPull > 0
                ? `Fast-forward this branch to its copy on origin. ${trackDescription(upstream)}`
                : "Fast-forward this branch to its copy on origin"
            }
            onClick={() => void sync("pull")}
          >
            Pull
            {toPull > 0 ? <span className="sync-count">↓{toPull}</span> : null}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon="upload"
            aria-label={toPush > 0 ? `Push, ${toPush} to push` : undefined}
            loading={syncing === "push"}
            disabled={!!syncing}
            tooltip={
              toPush > 0 ? `Push this branch to origin. ${trackDescription(upstream)}` : "Push this branch to origin"
            }
            onClick={() => void sync("push")}
          >
            Push
            {toPush > 0 ? <span className="sync-count">↑{toPush}</span> : null}
          </Button>
        </div>
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
        busy ? (
          <LoadingState label="Loading changes" />
        ) : (
          <EmptyState
            icon="diff"
            title="Changes not loaded"
            detail={`Refresh to compare with ${baseRef || "the base branch"}.`}
          />
        )
      ) : (
        <div className="review-body">
          <div className="review-summary-row">
            <div className={`review-summary${conflicted ? " is-conflicted" : ""}`} role="status">
              {conflicted
                ? `${review.conflictFiles.length} conflict${review.conflictFiles.length === 1 ? "" : "s"} need attention.`
                : review.files.length === 0
                  ? "Working tree is clean."
                  : `${plural(review.files.length, "changed file")}${stagedCount > 0 ? `, ${stagedCount} staged` : ""}`}
            </div>
            {anyUnstaged ? (
              <Button
                size="xs"
                variant="ghost"
                tooltip="Stage every change, new files included"
                disabled={changing || busy}
                onClick={() => void change(() => stageFiles(dispatch, worktree.worktreeId))}
              >
                Stage all
              </Button>
            ) : null}
            {stagedCount > 0 ? (
              <Button
                size="xs"
                variant="ghost"
                tooltip="Move every staged change back to the working tree"
                disabled={changing || busy}
                onClick={() => void change(() => unstageFiles(dispatch, worktree.worktreeId))}
              >
                Unstage all
              </Button>
            ) : null}
          </div>
          {review.files.length > 0 ? (
            <div className="review-file-list">
              {review.files.map((file, index) => {
                const state = stageStates[index] ?? "committed";
                return (
                  <div
                    className={`review-file-row${review.diff?.path === file.path ? " is-selected" : ""}`}
                    key={file.path}
                  >
                    {state === "committed" ? (
                      <span className="review-file-check" title="Committed on this branch; nothing to stage" />
                    ) : (
                      <input
                        type="checkbox"
                        className="review-file-check"
                        aria-label={`Stage ${file.path}`}
                        data-tooltip={stageTooltips[state]}
                        checked={state === "staged"}
                        ref={(element) => {
                          if (element) element.indeterminate = state === "partial";
                        }}
                        disabled={changing || busy}
                        onChange={() => toggleStage(file, state)}
                      />
                    )}
                    <button
                      className="review-file"
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
                    {state === "committed" ? null : (
                      <IconButton
                        className="review-file-discard"
                        label={`Discard changes to ${file.path}`}
                        tooltip="Discard changes"
                        icon="undo"
                        size="xs"
                        tone="danger"
                        disabled={changing || busy}
                        onClick={() => setDiscarding({ kind: "file", file })}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}
          {review.diff ? (
            <ReviewDiff
              worktreeId={worktree.worktreeId}
              diff={review.diff}
              part={diffPart}
              disabled={changing || busy}
              onPart={setDiffPart}
              onHunk={onHunk}
            />
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
          <StashSection
            worktreeId={worktree.worktreeId}
            hasChanges={hasLocalChanges}
            disabled={changing || busy}
            onChanged={(text) => void change(async () => undefined, text)}
          />
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
              disabled={busy || changing || !message.trim() || review.state === "conflicted"}
              tooltip={
                stagedCount > 0
                  ? "Commit only the staged changes. Unstaged changes stay in the working tree."
                  : "Nothing is staged, so every change is committed, new files included."
              }
              onClick={() =>
                void run({ type: "review.commit", worktreeId: worktree.worktreeId, message: message.trim() })
              }
            >
              {stagedCount > 0 ? `Commit ${plural(stagedCount, "staged file")}` : "Commit all changes"}
            </Button>
          </div>
          <div className="review-merge">
            <span className="inline-field">
              <span aria-hidden="true">Merge target</span>
              <Picker
                variant="field"
                className="input-sm review-branch-picker"
                label="Merge target"
                value={targetRef}
                options={targetChoices}
                onChange={(next) => {
                  setTargetRef(next);
                  setTargetTouched(true);
                }}
              >
                <span className="picker-trigger-label">{targetRef}</span>
              </Picker>
            </span>
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
            onMerged={(result) => {
              setNotice(
                result.branchDeleted
                  ? `Merged #${result.pullRequest.number} and deleted ${worktree.branch} on origin.`
                  : `Merged #${result.pullRequest.number} on GitHub.`,
              );
              void branchState.reload();
            }}
          />
        </div>
      ) : null}
      {discarding ? (
        <ConfirmDialog
          {...discardCopy(discarding)}
          busy={changing}
          onConfirm={() => void confirmDiscard(discarding)}
          onCancel={() => setDiscarding(undefined)}
        />
      ) : null}
      {worktree && branchMenuOpen ? (
        <BranchMenu
          worktree={worktree}
          branches={branches}
          onClose={() => setBranchMenuOpen(false)}
          onChanged={(result, noticeMessage, close) => {
            branchState.apply(result);
            setError(undefined);
            setNotice(noticeMessage);
            if (close) setBranchMenuOpen(false);
            if (review) refresh();
            void refreshPullRequest(dispatch, worktree.worktreeId, true);
          }}
        />
      ) : null}
      {mergeOpen && worktree ? (
        <MergeBranchDialog
          branch={worktree.branch}
          target={targetRef}
          onClose={() => setMergeOpen(false)}
          onMerge={async (target) => {
            setTargetRef(target);
            setTargetTouched(true);
            const merged = await run({ type: "review.merge", worktreeId: worktree.worktreeId, targetRef: target });
            if (merged) setMergeOpen(false);
          }}
        />
      ) : null}
      {shownError ? (
        <p className="inline-error" role="alert">
          <Icon name="alert" size={13} />
          <span>{shownError}</span>
        </p>
      ) : notice ? (
        <p className="review-notice" role="status">
          <Icon name="check" size={13} />
          <span>{notice}</span>
        </p>
      ) : null}
    </div>
  );
}

function discardCopy(target: Discard): { label: string; title: string; detail: string; confirmLabel: string } {
  if (target.kind === "hunk") {
    return {
      label: "Discard hunk",
      title: "Discard this hunk?",
      detail: `Removes the hunk's changes from ${target.path} in the working tree. This cannot be undone.`,
      confirmLabel: "Discard hunk",
    };
  }
  const { file } = target;
  if (file.kind === "untracked") {
    return {
      label: "Delete file",
      title: `Delete ${file.path}?`,
      detail: "Git does not track this file, so discarding deletes it from disk. This cannot be undone.",
      confirmLabel: "Delete file",
    };
  }
  return {
    label: "Discard changes",
    title: `Discard changes to ${file.path}?`,
    detail:
      file.kind === "added"
        ? "The file is not in the last commit, so discarding deletes it from disk. This cannot be undone."
        : "Puts the file back the way it is in the last commit, staged and unstaged changes included. This cannot be undone.",
    confirmLabel: "Discard changes",
  };
}

/** The open file's diff, split into its unstaged and staged halves when Git can stage it hunk by hunk. */
function ReviewDiff({
  worktreeId,
  diff,
  part,
  disabled,
  onPart,
  onHunk,
}: {
  worktreeId: string;
  diff: ReviewDiffProjection;
  part: DiffPart;
  disabled: boolean;
  onPart(part: DiffPart): void;
  onHunk(path: string, action: GitHunkAction, index: number, hunk: string): void;
}) {
  const parts =
    diff.stagedPatch !== undefined && diff.unstagedPatch !== undefined
      ? { staged: diff.stagedPatch, unstaged: diff.unstagedPatch }
      : undefined;
  if (!parts) return <DiffView worktreeId={worktreeId} diff={diff} />;
  const other: DiffPart = part === "staged" ? "unstaged" : "staged";
  // After the last hunk of one half moves, show the other half instead of an empty diff.
  const shown = parts[part] || !parts[other] ? part : other;
  return (
    <DiffView
      worktreeId={worktreeId}
      diff={{ ...diff, patch: parts[shown] }}
      toolbar={
        <Segmented<DiffPart>
          label="Diff to show"
          className="review-diff-parts"
          value={shown}
          onChange={onPart}
          options={[
            {
              value: "unstaged",
              label: `Unstaged ${hunkCount(parts.unstaged)}`,
              ariaLabel: `Unstaged, ${plural(hunkCount(parts.unstaged), "hunk")}`,
              tooltip: "Changes in the working tree that are not staged",
            },
            {
              value: "staged",
              label: `Staged ${hunkCount(parts.staged)}`,
              ariaLabel: `Staged, ${plural(hunkCount(parts.staged), "hunk")}`,
              tooltip: "Changes staged for the next commit",
            },
          ]}
        />
      }
      hunkActions={{
        actions: shown === "staged" ? ["unstage"] : ["stage", "discard"],
        disabled,
        onAction: (action, index, hunk) => onHunk(diff.path, action, index, hunk),
      }}
      emptyText={shown === "staged" ? "Nothing in this file is staged." : "Every change in this file is staged."}
    />
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
