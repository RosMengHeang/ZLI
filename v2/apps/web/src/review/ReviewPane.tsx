import type { WorktreeProjection } from "@zli-v2/contracts";

export function ReviewPane({ worktree }: { worktree: WorktreeProjection | undefined }) {
  return (
    <div className="tool-pane review-pane">
      <div className="tool-pane-header"><div><span className="eyebrow">Review</span><h2>{worktree?.branch ?? "No worktree selected"}</h2></div><span className="pane-meta">Git</span></div>
      {!worktree ? <div className="empty-pane"><p className="empty-title">Select a worktree</p><p className="empty-detail">Changes and merge actions are scoped to the selected worktree.</p></div> : <div className="empty-pane"><p className="empty-title">No review loaded</p><p className="empty-detail">The review surface will show real staged and unstaged changes once the Git review service is connected.</p><span className="coming-soon">Review service in progress</span></div>}
    </div>
  );
}
