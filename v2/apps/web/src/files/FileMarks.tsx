import type { FileChangeStatus } from "@zli-v2/contracts";

export const statusLetter: Record<FileChangeStatus, string> = {
  modified: "M",
  added: "A",
  untracked: "U",
  deleted: "D",
  renamed: "R",
  conflicted: "!",
};

export const statusLabel: Record<FileChangeStatus, string> = {
  modified: "Modified",
  added: "Added",
  untracked: "New, not tracked by Git",
  deleted: "Deleted",
  renamed: "Renamed",
  conflicted: "Merge conflict",
};

export function FileStatusMark({ status }: { status: FileChangeStatus | undefined }) {
  if (!status) return null;
  return (
    <span className={`file-status file-status-${status}`} title={statusLabel[status]}>
      {statusLetter[status]}
    </span>
  );
}

/** Lines added and removed, for example `+12 −3`. Renders nothing when Git gave no counts. */
export function LineCounts({
  additions,
  deletions,
}: {
  additions?: number | undefined;
  deletions?: number | undefined;
}) {
  if (additions === undefined || deletions === undefined) return null;
  return (
    <span className="file-counts" role="img" aria-label={`${additions} added, ${deletions} removed`}>
      <span className="is-add">+{additions}</span>
      <span className="is-del">−{deletions}</span>
    </span>
  );
}
