import type { RuntimeProjection, WorktreeProjection } from "@zli-v2/contracts";

type Props = { projection: RuntimeProjection | undefined; worktree: WorktreeProjection | undefined; onOpenBrowser(): void };

export function TerminalPane({ projection, worktree, onOpenBrowser }: Props) {
  const terminal = projection?.terminals.find((candidate) => candidate.worktreeId === worktree?.worktreeId);
  return (
    <div className="tool-pane terminal-pane">
      <div className="tool-pane-header"><div><span className="eyebrow">Terminal</span><h2>{worktree?.branch ?? "No worktree selected"}</h2></div><span className="pane-meta">{terminal ? terminal.status : "Idle"}</span></div>
      {!worktree ? <EmptyPane title="Select a worktree" detail="Terminal sessions belong to a worktree, so there is nothing to attach yet." /> : terminal ? <div className="terminal-output" role="log" aria-label="Terminal output"><p className="terminal-muted">Terminal session connected.</p><p><span className="terminal-prompt">{worktree.branch}</span> workspace ready</p></div> : <div className="empty-pane"><p className="empty-title">No terminal session</p><p className="empty-detail">The runtime has not started a terminal for this worktree.</p><button className="secondary-button" type="button" onClick={onOpenBrowser}>Open browser workspace</button></div>}
    </div>
  );
}

function EmptyPane({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-pane"><p className="empty-title">{title}</p><p className="empty-detail">{detail}</p></div>;
}
