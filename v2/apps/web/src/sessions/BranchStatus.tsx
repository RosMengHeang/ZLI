import { Icon } from "../ui/Icon.js";
import type { BranchRead } from "./projectBranch.js";

/**
 * A folder's branch in one short line: reading, could not be read (with Retry), detached, not Git, or the branch.
 * Secondary information, so every state stays small and dim.
 */
export function BranchStatus({
  read,
  onRetry,
  className,
}: {
  read: BranchRead | undefined;
  onRetry?: () => void;
  className?: string;
}) {
  if (!read) return null;
  const classes = (state: string) => ["folder-branch", state, className].filter(Boolean).join(" ");
  if (read.status === "loading") {
    return (
      <span className={classes("is-loading")} role="status">
        Reading branch…
      </span>
    );
  }
  if (read.status === "failed") {
    return (
      <span className={classes("is-failed")} role="status">
        <span>Couldn't read the branch</span>
        {onRetry ? (
          <button type="button" className="folder-branch-retry" onClick={onRetry}>
            Retry
          </button>
        ) : null}
      </span>
    );
  }
  const { result } = read;
  if (!result.git) return <span className={classes("is-plain")}>Not a Git repository</span>;
  if (result.branch) {
    return (
      <span className={classes("is-branch")} title={result.branch}>
        <Icon name="branch" size={12} />
        <span className="folder-branch-name">{result.branch}</span>
      </span>
    );
  }
  return (
    <span className={classes("is-detached")} title="HEAD is not on a branch">
      <Icon name="branch" size={12} />
      <span>Detached</span>
      {result.detachedAt ? <span className="folder-branch-name">{result.detachedAt}</span> : null}
    </span>
  );
}
