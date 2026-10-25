import type { CheckpointDiffResult, ThreadCheckpoint, TurnCheckpointFile } from "@zli-v2/contracts";
import { type KeyboardEvent, memo, useRef, useState } from "react";
import { isMarkdownPath } from "../files/fileViewModes.js";
import { DiffView } from "../review/DiffView.js";
import { parseDiffLines, patchBody } from "../review/diffLines.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Icon } from "../ui/Icon.js";
import { ImageViewer, isImagePath } from "./ChatImage.js";
import { readCheckpointDiff, restoreCheckpoint } from "./checkpointClient.js";

type DiffState =
  | { kind: "loading" }
  | { kind: "ready"; diff: CheckpointDiffResult }
  | { kind: "error"; message: string };

const kindLabel: Partial<Record<TurnCheckpointFile["kind"], string>> = {
  added: "new",
  deleted: "deleted",
  renamed: "renamed",
};

/**
 * What one turn changed on disk, with each file's diff on demand and a way to undo the turn.
 * Markdown files open in the Files panel to read, and images open full size. With a worktree, the
 * diff lines take review comments like the Changes panel.
 */
export const TurnChanges = memo(function TurnChanges({
  checkpoint,
  worktreeId,
  displayName,
  branch,
  restoreBlocked,
  onOpenFile,
}: {
  checkpoint: ThreadCheckpoint;
  worktreeId?: string | undefined;
  displayName: string;
  branch: string;
  /** Why restoring is not possible right now, for example while an agent is working. */
  restoreBlocked: string | undefined;
  onOpenFile?: ((path: string) => void) | undefined;
}) {
  const { dispatch } = useRuntime();
  const [openPath, setOpenPath] = useState<string>();
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({});
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string>();
  const [viewing, setViewing] = useState<string>();

  const toggle = (path: string) => {
    if (openPath === path) {
      setOpenPath(undefined);
      return;
    }
    setOpenPath(path);
    const known = diffs[path];
    if (known && known.kind !== "error") return;
    setDiffs((current) => ({ ...current, [path]: { kind: "loading" } }));
    readCheckpointDiff(dispatch, checkpoint.checkpointId, path).then(
      (diff) => setDiffs((current) => ({ ...current, [path]: { kind: "ready", diff } })),
      (cause: unknown) =>
        setDiffs((current) => ({
          ...current,
          [path]: { kind: "error", message: cause instanceof Error ? cause.message : "The diff could not be read." },
        })),
    );
  };

  const restore = async () => {
    setConfirming(false);
    setRestoring(true);
    setError(undefined);
    try {
      await restoreCheckpoint(dispatch, checkpoint.checkpointId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The files could not be restored.");
    } finally {
      setRestoring(false);
    }
  };

  const hidden = checkpoint.fileCount - checkpoint.files.length;
  return (
    <section className="turn-changes" aria-label="Changes in this turn">
      <header className="turn-changes-header">
        <Icon name="diff" size={13} />
        <span className="turn-changes-title">
          {checkpoint.fileCount} {checkpoint.fileCount === 1 ? "file" : "files"} changed
        </span>
        <LineCounts additions={checkpoint.additions} deletions={checkpoint.deletions} />
        <Button
          variant="ghost"
          size="xs"
          icon="rotate"
          loading={restoring}
          disabled={!!restoreBlocked}
          tooltip={restoreBlocked ?? "Put the files back to how they were before this turn"}
          onClick={() => setConfirming(true)}
        >
          Restore
        </Button>
      </header>
      <ul className="turn-changes-list">
        {checkpoint.files.map((file) => {
          const open = openPath === file.path;
          const normalized = file.path.replaceAll("\\", "/");
          const slash = normalized.lastIndexOf("/");
          const label = kindLabel[file.kind];
          const opens =
            file.kind === "deleted"
              ? undefined
              : isImagePath(file.path)
                ? "image"
                : onOpenFile && isMarkdownPath(file.path)
                  ? "file"
                  : undefined;
          return (
            <li key={file.path} className={open ? "is-open" : undefined}>
              <button
                type="button"
                className="turn-file"
                {...(opens ? {} : { "aria-expanded": open })}
                title={
                  opens === "image"
                    ? `View ${file.path}`
                    : opens === "file"
                      ? `Read ${file.path} in the Files panel`
                      : file.oldPath
                        ? `${file.oldPath} to ${file.path}`
                        : file.path
                }
                onClick={() => {
                  if (opens === "image") setViewing(file.path);
                  else if (opens === "file") onOpenFile?.(file.path);
                  else toggle(file.path);
                }}
              >
                <Icon
                  name={opens === "image" ? "image" : opens === "file" ? "fileText" : "chevronRight"}
                  size={11}
                  className={opens ? "turn-file-icon" : "turn-file-chevron"}
                />
                <span className="turn-file-path">
                  <span className={`turn-file-name${file.kind === "deleted" ? " is-deleted" : ""}`}>
                    {normalized.slice(slash + 1)}
                  </span>
                  {slash > 0 ? <span className="turn-file-dir">{normalized.slice(0, slash)}</span> : null}
                </span>
                {label ? <span className={`turn-file-kind is-${file.kind}`}>{label}</span> : null}
                {file.binary ? (
                  <span className="turn-file-kind">binary</span>
                ) : (
                  <LineCounts additions={file.additions} deletions={file.deletions} />
                )}
              </button>
              {open ? (
                <TurnDiff path={file.path} worktreeId={worktreeId} state={diffs[file.path] ?? { kind: "loading" }} />
              ) : null}
            </li>
          );
        })}
        {hidden > 0 ? <li className="turn-changes-more">and {hidden} more</li> : null}
      </ul>
      {error ? (
        <p className="inline-error turn-changes-error" role="alert">
          {error}
        </p>
      ) : null}
      {viewing ? <ImageViewer source={{ path: viewing }} onClose={() => setViewing(undefined)} /> : null}
      {confirming ? (
        <RestoreDialog
          checkpoint={checkpoint}
          displayName={displayName}
          branch={branch}
          onRestore={() => void restore()}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </section>
  );
});

function LineCounts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="turn-counts" role="img" aria-label={`${additions} added, ${deletions} removed`}>
      <span className="is-add">+{additions}</span>
      <span className="is-del">-{deletions}</span>
    </span>
  );
}

function TurnDiff({ path, worktreeId, state }: { path: string; worktreeId: string | undefined; state: DiffState }) {
  if (state.kind === "loading") {
    return (
      <p className="turn-diff-note" role="status">
        <span className="spinner" aria-hidden="true" />
        Loading diff
      </p>
    );
  }
  if (state.kind === "error") {
    return (
      <p className="inline-error turn-diff-note" role="alert">
        {state.message}
      </p>
    );
  }
  const { diff } = state;
  if (diff.binary) return <p className="turn-diff-note">Binary file. There is no text diff to show.</p>;
  if (!diff.patch.trim()) return <p className="turn-diff-note">Only the name or file mode changed.</p>;
  const patch = diff.patch.replace(/\r?\n$/u, "");
  if (worktreeId) {
    return (
      <div className="turn-diff-review">
        <DiffView worktreeId={worktreeId} diff={{ path, patch, binary: false, truncated: diff.truncated }} />
      </div>
    );
  }
  const lines = parseDiffLines(patchBody(patch));
  return (
    <section className="turn-diff" aria-label={`Diff for ${path}`}>
      <div className="turn-diff-lines">
        {lines.map((line) => (
          <div key={line.index} className={`turn-diff-line is-${line.kind}`}>
            <span className="turn-diff-num" aria-hidden="true">
              {line.oldLine ?? ""}
            </span>
            <span className="turn-diff-num" aria-hidden="true">
              {line.newLine ?? ""}
            </span>
            <span className="turn-diff-text">{line.text || " "}</span>
          </div>
        ))}
      </div>
      {diff.truncated ? <p className="turn-diff-note">The diff is too long to show in full.</p> : null}
    </section>
  );
}

function RestoreDialog({
  checkpoint,
  displayName,
  branch,
  onRestore,
  onCancel,
}: {
  checkpoint: ThreadCheckpoint;
  displayName: string;
  branch: string;
  onRestore(): void;
  onCancel(): void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const closeOnEscape = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") onCancel();
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape from anywhere inside the dialog closes it.
    <div onKeyDown={closeOnEscape}>
      <Dialog
        label="Restore files"
        size="sm"
        title="Restore files to before this turn?"
        subtitle={`Every file in ${branch} goes back to how it was before ${displayName} started this turn. That also undoes later turns and your own uncommitted edits. Commits and ignored files stay as they are.`}
        scrimLabel="Cancel"
        showClose={false}
        initialFocusRef={cancelRef}
        onClose={onCancel}
      >
        <div className="dialog-body">
          <p className="turn-restore-note">
            This turn changed {checkpoint.fileCount} {checkpoint.fileCount === 1 ? "file" : "files"}. {displayName} is
            not told about the restore, so mention it in your next message.
          </p>
        </div>
        <div className="dialog-footer">
          <Button ref={cancelRef} onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="danger" icon="rotate" onClick={onRestore}>
            Restore files
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
