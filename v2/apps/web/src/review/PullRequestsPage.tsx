import type { PullRequestInfo, RuntimeProjection, WorktreeProjection } from "@zli-v2/contracts";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { relativeTime } from "../sessions/sessions.js";
import { ProjectMark } from "../sidebar/ProjectMark.js";
import { Icon } from "../ui/Icon.js";
import { PullRequestPane } from "./PullRequestPane.js";
import { usePullRequestEntries, usePullRequestPolling } from "./pullRequestStore.js";

type Row = { worktree: WorktreeProjection; pullRequest: PullRequestInfo };

/** Where a pull request stands, as a word and a tone: draft, open with checks running or failing, or merged. */
function standing(pullRequest: PullRequestInfo): { label: string; tone: string } {
  if (pullRequest.state === "MERGED") return { label: "Merged", tone: "merged" };
  if (pullRequest.state === "CLOSED") return { label: "Closed", tone: "closed" };
  const checks = pullRequest.checks ?? [];
  if (checks.some((check) => check.state === "failed")) return { label: "Checks failed", tone: "failed" };
  if (checks.some((check) => check.state === "pending")) return { label: "Checks running", tone: "pending" };
  if (pullRequest.isDraft) return { label: "Draft", tone: "draft" };
  return { label: pullRequest.reviewDecision === "APPROVED" ? "Approved" : "Open", tone: "open" };
}

/**
 * Every pull request the app's worktrees have, like an inbox: open ones first, then merged and closed, each with
 * its project, branch and where it stands. The chosen one opens on the right, with its checks, description and
 * reviews.
 */
export function PullRequestsPage({
  projection,
  selectedId,
  onSelect,
  onOpenChanges,
  onShowAgent,
}: {
  projection: RuntimeProjection;
  /** The worktree whose pull request is open on the right. */
  selectedId: string | undefined;
  onSelect(worktreeId: string): void;
  onOpenChanges(worktreeId: string): void;
  onShowAgent(sessionId: string): void;
}) {
  const entries = usePullRequestEntries();
  // Looks up every ready worktree's pull request, so the page fills in on its own.
  const { dispatch } = useRuntime();
  usePullRequestPolling(
    dispatch,
    projection.worktrees.filter((entry) => entry.status === "ready").map((entry) => entry.worktreeId),
  );
  const rows: Row[] = [];
  for (const worktree of projection.worktrees) {
    const pullRequest = entries.get(worktree.worktreeId)?.status?.pullRequest;
    if (pullRequest) rows.push({ worktree, pullRequest });
  }
  const newest = (left: Row, right: Row) =>
    (right.pullRequest.updatedAt ?? "").localeCompare(left.pullRequest.updatedAt ?? "");
  const open = rows.filter((row) => row.pullRequest.state === "OPEN").sort(newest);
  const done = rows.filter((row) => row.pullRequest.state !== "OPEN").sort(newest);
  const selected = rows.find((row) => row.worktree.worktreeId === selectedId) ?? open[0] ?? done[0];

  const renderRow = (row: Row) => {
    const { worktree, pullRequest } = row;
    const project = projection.projects.find((entry) => entry.projectId === worktree.projectId);
    const state = standing(pullRequest);
    const active = selected?.worktree.worktreeId === worktree.worktreeId;
    return (
      <li key={worktree.worktreeId}>
        <button
          type="button"
          className={`pr-list-row is-${state.tone}${active ? " is-active" : ""}`}
          aria-current={active ? "page" : undefined}
          onClick={() => onSelect(worktree.worktreeId)}
        >
          <Icon name={pullRequest.state === "MERGED" ? "merge" : "pullRequest"} size={16} className="pr-list-icon" />
          <span className="pr-list-text">
            <span className="pr-list-title">
              <span className="pr-list-name">{pullRequest.title ?? worktree.branch}</span>
              {pullRequest.updatedAt ? (
                <span className="pr-list-time">{relativeTime(pullRequest.updatedAt)}</span>
              ) : null}
            </span>
            <span className="pr-list-meta">
              <span className="pr-list-number">#{pullRequest.number}</span>
              {project ? (
                <span className="pr-list-project">
                  <ProjectMark project={project} projection={projection} size={11} />
                  <span>{project.name}</span>
                </span>
              ) : null}
              <span className={`pr-list-state is-${state.tone}`}>{state.label}</span>
            </span>
          </span>
        </button>
      </li>
    );
  };

  return (
    <section className="pr-page" aria-label="Pull requests">
      <nav className="pr-list" aria-label="Pull request list">
        <header className="pr-list-head">
          <h2>Pull requests</h2>
          <span className="pr-list-count">{open.length} open</span>
        </header>
        <div className="pr-list-scroll">
          {rows.length === 0 ? (
            <p className="pr-list-empty">
              No pull requests yet. When an agent or a buddy opens one from its branch, it shows here.
            </p>
          ) : null}
          {open.length > 0 ? (
            <section className="pr-list-section" aria-label="Open">
              <h3 className="pr-list-heading">Open</h3>
              <ul>{open.map(renderRow)}</ul>
            </section>
          ) : null}
          {done.length > 0 ? (
            <section className="pr-list-section" aria-label="Merged and closed">
              <h3 className="pr-list-heading">Merged and closed</h3>
              <ul>{done.map(renderRow)}</ul>
            </section>
          ) : null}
        </div>
      </nav>
      <div className="pr-page-detail">
        {/* The same bar as a chat's head: which pull request, and from which branch into which. */}
        <header className="pr-page-head">
          {selected ? (
            <>
              <Icon name={selected.pullRequest.state === "MERGED" ? "merge" : "pullRequest"} size={15} />
              <span className="pr-page-head-title">#{selected.pullRequest.number}</span>
              <span className="pr-page-head-branch">
                {selected.pullRequest.headRefName ?? selected.worktree.branch}
                {selected.pullRequest.baseRefName ? ` → ${selected.pullRequest.baseRefName}` : ""}
              </span>
            </>
          ) : null}
        </header>
        {selected ? (
          <PullRequestPane
            worktree={selected.worktree}
            onOpenChanges={() => onOpenChanges(selected.worktree.worktreeId)}
            onShowAgent={onShowAgent}
          />
        ) : (
          <div className="pr-page-empty">
            <Icon name="pullRequest" size={28} />
            <p>Pick a pull request to see its checks, description and reviews.</p>
          </div>
        )}
      </div>
    </section>
  );
}
