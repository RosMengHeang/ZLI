import type { RuntimeProjection, WorktreeProjection } from "@zli-v2/contracts";

type Props = {
  projection: RuntimeProjection | undefined;
  activeWorktreeId: string | undefined;
  onSelect(worktree: WorktreeProjection): void;
  onOpenProject(): void;
  onCreateWorktree(): void;
};

const statusLabel: Record<WorktreeProjection["status"], string> = {
  queued: "Queued",
  fetching: "Fetching",
  creating: "Creating",
  bootstrapping: "Preparing",
  ready: "Ready",
  failed: "Failed",
  cancelling: "Cancelling",
  cancelled: "Cancelled",
};

export function WorktreeSidebar({ projection, activeWorktreeId, onSelect, onOpenProject, onCreateWorktree }: Props) {
  const projects = projection?.projects ?? [];
  const worktrees = projection?.worktrees ?? [];
  return (
    <aside className="worktree-sidebar" aria-label="Projects and worktrees">
      <div className="sidebar-heading">
        <span className="wordmark">ZLI</span>
        <div className="sidebar-actions"><button className="quiet-button" type="button" onClick={onOpenProject} aria-label="Open project">Open</button><button className="quiet-button" type="button" onClick={onCreateWorktree} disabled={projects.length === 0} aria-label="Create worktree">New</button></div>
      </div>
      <div className="sidebar-scroll">
        {projects.length === 0 ? (
          <div className="sidebar-empty">
            <p>No project connected.</p>
            <button className="text-button" type="button" onClick={onOpenProject}>Open a folder</button>
          </div>
        ) : projects.map((project) => {
          const projectWorktrees = worktrees.filter((worktree) => worktree.projectId === project.projectId);
          return (
            <section className="project-tree" key={project.projectId}>
              <div className="project-label" title={project.path}><span aria-hidden="true">▾</span><span>{project.name}</span></div>
              {projectWorktrees.length === 0 ? <p className="tree-note">No worktrees yet.</p> : projectWorktrees.map((worktree) => (
                <button
                  className={`worktree-row${activeWorktreeId === worktree.worktreeId ? " is-active" : ""}`}
                  key={worktree.worktreeId}
                  type="button"
                  onClick={() => onSelect(worktree)}
                  title={worktree.path}
                >
                  <span className={`status-dot status-${worktree.status}`} aria-hidden="true" />
                  <span className="worktree-name">{worktree.branch}</span>
                  <span className="worktree-status">{statusLabel[worktree.status]}</span>
                </button>
              ))}
            </section>
          );
        })}
      </div>
      <div className="sidebar-footer">
        <span className={`connection-dot${projection ? " is-connected" : ""}`} aria-hidden="true" />
        <span>{projection ? "Local runtime" : "Waiting for runtime"}</span>
      </div>
    </aside>
  );
}
