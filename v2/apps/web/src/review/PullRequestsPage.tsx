import type { PullRequestInfo, RuntimeProjection, WorktreeProjection } from "@zli-v2/contracts";
import { useState } from "react";

import { useRuntime } from "../runtime/RuntimeProvider.js";
import { relativeTime } from "../sessions/sessions.js";
import { checksView } from "../shell/overview.js";
import { ProjectMark } from "../sidebar/ProjectMark.js";
import { Icon } from "../ui/Icon.js";
import { MenuButton, type MenuItem } from "../ui/Menu.js";
import { PullRequestPane } from "./PullRequestPane.js";
import { usePullRequestEntries, usePullRequestPolling } from "./pullRequestStore.js";

export type PullRequestRow = {
  worktree: WorktreeProjection;
  pullRequest: PullRequestInfo;
  project?: string | undefined;
};
export type PullRequestSort = "updated" | "status" | "project" | "number";
export type SortDirection = "desc" | "asc";
export type PullRequestGroup = { label: string; rows: PullRequestRow[] };

const SORTS: readonly { value: PullRequestSort; label: string; short: string; detail: string }[] = [
  { value: "updated", label: "Last updated", short: "Updated", detail: "Open first, then merged and closed" },
  { value: "status", label: "Status", short: "Status", detail: "Failing checks first, drafts last" },
  { value: "project", label: "Project", short: "Project", detail: "One section per project, A to Z" },
  { value: "number", label: "Number", short: "Number", detail: "By pull request number" },
];
const SORT_KEY = "zli.pullRequests.sort";

/** Where a pull request stands, as a word, a tone, and a rank for sorting by status (lower needs you sooner). */
export function standing(pullRequest: PullRequestInfo): { label: string; tone: string; rank: number } {
  if (pullRequest.state === "MERGED") return { label: "Merged", tone: "merged", rank: 4 };
  if (pullRequest.state === "CLOSED") return { label: "Closed", tone: "closed", rank: 4 };
  const checks = pullRequest.checks ?? [];
  if (checks.some((check) => check.state === "failed")) return { label: "Checks failed", tone: "failed", rank: 0 };
  if (checks.some((check) => check.state === "pending")) return { label: "Checks running", tone: "pending", rank: 1 };
  if (pullRequest.isDraft) return { label: "Draft", tone: "draft", rank: 3 };
  return { label: pullRequest.reviewDecision === "APPROVED" ? "Approved" : "Open", tone: "open", rank: 2 };
}

const STATUS_GROUPS = ["Checks failed", "Checks running", "Ready to review", "Drafts", "Merged and closed"];

/**
 * Puts the rows into the list's sections for a sort. The direction orders rows inside each section: newest or
 * oldest for time, highest or lowest for number. Last updated and Number keep open ones above merged and closed;
 * Status runs from what needs you first down to drafts; Project is one section per project, A to Z.
 */
export function groupPullRequests(
  rows: readonly PullRequestRow[],
  sort: PullRequestSort,
  direction: SortDirection = "desc",
): PullRequestGroup[] {
  const flip = direction === "desc" ? -1 : 1;
  const byTime = (left: PullRequestRow, right: PullRequestRow) =>
    flip * (left.pullRequest.updatedAt ?? "").localeCompare(right.pullRequest.updatedAt ?? "");
  const byNumber = (left: PullRequestRow, right: PullRequestRow) =>
    flip * (left.pullRequest.number - right.pullRequest.number);
  const order = sort === "number" ? byNumber : byTime;
  const isOpen = (row: PullRequestRow) => row.pullRequest.state === "OPEN";
  const groups = new Map<string, PullRequestRow[]>();
  const add = (label: string, row: PullRequestRow) => groups.set(label, [...(groups.get(label) ?? []), row]);

  if (sort === "status") {
    for (const row of rows) add(STATUS_GROUPS[standing(row.pullRequest).rank] ?? "Open", row);
    return STATUS_GROUPS.filter((label) => groups.has(label)).map((label) => ({
      label,
      rows: (groups.get(label) ?? []).sort(order),
    }));
  }
  if (sort === "project") {
    for (const row of rows) add(row.project ?? "No project", row);
    return [...groups.keys()]
      .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }))
      .map((label) => ({
        label,
        rows: (groups.get(label) ?? []).sort((left, right) =>
          isOpen(left) === isOpen(right) ? order(left, right) : isOpen(left) ? -1 : 1,
        ),
      }));
  }
  return [
    { label: "Open", rows: rows.filter(isOpen).sort(order) },
    { label: "Merged and closed", rows: rows.filter((row) => !isOpen(row)).sort(order) },
  ].filter((group) => group.rows.length > 0);
}

type SavedSort = { sort: PullRequestSort; direction: SortDirection };

function readSort(): SavedSort {
  try {
    const saved = JSON.parse(window.localStorage.getItem(SORT_KEY) ?? "null") as Partial<SavedSort> | null;
    return {
      sort: SORTS.some((option) => option.value === saved?.sort) ? (saved?.sort as PullRequestSort) : "updated",
      direction: saved?.direction === "asc" ? "asc" : "desc",
    };
  } catch {
    return { sort: "updated", direction: "desc" };
  }
}

function saveSort(value: SavedSort) {
  try {
    window.localStorage.setItem(SORT_KEY, JSON.stringify(value));
  } catch {
    // The choice only lasts this session when storage is blocked.
  }
}

/** The words on the direction button, which depend on what is being sorted. */
function directionLabel(sort: PullRequestSort, direction: SortDirection): string {
  if (sort === "number") return direction === "desc" ? "Highest first" : "Lowest first";
  return direction === "desc" ? "Newest first" : "Oldest first";
}

/**
 * Every pull request the app's worktrees have, like an inbox, in the order picked in the sort bar. The chosen one
 * opens on the right, with its summary and its code.
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
  const [{ sort, direction }, setSortState] = useState<SavedSort>(readSort);
  const setSort = (next: SavedSort) => {
    setSortState(next);
    saveSort(next);
  };
  // Looks up every ready worktree's pull request, so the page fills in on its own.
  const { dispatch } = useRuntime();
  usePullRequestPolling(
    dispatch,
    projection.worktrees.filter((entry) => entry.status === "ready").map((entry) => entry.worktreeId),
  );
  const rows: PullRequestRow[] = [];
  for (const worktree of projection.worktrees) {
    const pullRequest = entries.get(worktree.worktreeId)?.status?.pullRequest;
    const project = projection.projects.find((entry) => entry.projectId === worktree.projectId)?.name;
    if (pullRequest) rows.push({ worktree, pullRequest, project });
  }
  const groups = groupPullRequests(rows, sort, direction);
  const ordered = groups.flatMap((group) => group.rows);
  const selected =
    rows.find((row) => row.worktree.worktreeId === selectedId) ??
    ordered.find((row) => row.pullRequest.state === "OPEN") ??
    ordered[0];
  const sortOption = SORTS.find((option) => option.value === sort) ?? { label: "Last updated", short: "Updated" };

  const sortItems = (): MenuItem[] => [
    { heading: "Sort by" },
    ...SORTS.map((option) => ({
      id: option.value,
      label: option.label,
      title: option.detail,
      checked: option.value === sort,
      run: () => setSort({ sort: option.value, direction }),
    })),
  ];

  const renderRow = (row: PullRequestRow) => {
    const { worktree, pullRequest } = row;
    const project = projection.projects.find((entry) => entry.projectId === worktree.projectId);
    const state = standing(pullRequest);
    const checks = pullRequest.state === "OPEN" ? checksView(pullRequest) : undefined;
    const active = selected?.worktree.worktreeId === worktree.worktreeId;
    return (
      <li key={worktree.worktreeId}>
        <button
          type="button"
          className={`pr-list-row is-${state.tone}${active ? " is-active" : ""}`}
          aria-current={active ? "page" : undefined}
          onClick={() => onSelect(worktree.worktreeId)}
        >
          <Icon name={pullRequest.state === "MERGED" ? "merge" : "pullRequest"} size={15} className="pr-list-icon" />
          <span className="pr-list-text">
            <span className="pr-list-title">
              <span className="pr-list-name">{pullRequest.title ?? worktree.branch}</span>
              {pullRequest.updatedAt ? (
                <span className="pr-list-time">{relativeTime(pullRequest.updatedAt)}</span>
              ) : null}
            </span>
            <span className="pr-list-meta">
              <span className="pr-list-number">#{pullRequest.number}</span>
              {project && sort !== "project" ? (
                <span className="pr-list-project">
                  <ProjectMark project={project} projection={projection} size={11} />
                  <span>{project.name}</span>
                </span>
              ) : null}
              <span className={`pr-list-state is-${state.tone}`}>{state.label}</span>
              {checks ? (
                <span className={`pr-checks-count is-${checks.tone}`} title={`Checks ${checks.headline}`}>
                  <Icon
                    name={checks.tone === "failed" ? "alert" : checks.tone === "pending" ? "loader" : "check"}
                    size={11}
                  />
                  {checks.count}
                </span>
              ) : null}
            </span>
          </span>
        </button>
      </li>
    );
  };

  return (
    <section className="pr-page" aria-label="Pull requests">
      <nav className="pr-list" aria-label="Pull request list">
        {/* The sort sits in the head: what the list is sorted by, then which way, each one click. */}
        <header className="pr-list-head">
          <h2>Pull requests</h2>
          {rows.length > 0 ? (
            <div className="pr-sort">
              <MenuButton
                label={`Sort by ${sortOption.label.toLowerCase()}`}
                tooltip="Sort by"
                icon="sort"
                size="xs"
                className="pr-sort-by"
                items={sortItems}
              >
                <span className="pr-sort-value">{sortOption.short}</span>
                <Icon name="chevronDown" size={11} />
              </MenuButton>
              <button
                type="button"
                className="pr-sort-direction"
                aria-label={`${directionLabel(sort, direction)}. Reverse the order`}
                data-tooltip={`${directionLabel(sort, direction)}. Click to reverse`}
                onClick={() => setSort({ sort, direction: direction === "desc" ? "asc" : "desc" })}
              >
                <Icon name="arrowUp" size={13} className={direction === "desc" ? "is-down" : undefined} />
              </button>
            </div>
          ) : null}
        </header>
        <div className="pr-list-scroll">
          {rows.length === 0 ? (
            <p className="pr-list-empty">
              No pull requests yet. When an agent or a buddy opens one from its branch, it shows here.
            </p>
          ) : null}
          {groups.map((group) => (
            <section key={group.label} className="pr-list-section" aria-label={group.label}>
              <h3 className="pr-list-heading">
                <span>{group.label}</span>
                <span className="pr-list-heading-count">{group.rows.length}</span>
              </h3>
              <ul>{group.rows.map(renderRow)}</ul>
            </section>
          ))}
        </div>
      </nav>
      <div className="pr-page-detail">
        {/* The same bar as a chat's head, clear of the window controls: which pull request, in which project. */}
        <header className="pr-page-head">
          {selected ? (
            <>
              <Icon
                name={selected.pullRequest.state === "MERGED" ? "merge" : "pullRequest"}
                size={15}
                className={`pr-page-head-icon is-${standing(selected.pullRequest).tone}`}
              />
              <span className="pr-page-head-title">#{selected.pullRequest.number}</span>
              {selected.project ? <span className="pr-page-head-branch">{selected.project}</span> : null}
            </>
          ) : null}
        </header>
        {selected ? (
          <PullRequestPane
            hideNumber
            worktree={selected.worktree}
            onOpenChanges={() => onOpenChanges(selected.worktree.worktreeId)}
            onShowAgent={onShowAgent}
          />
        ) : (
          <div className="pr-page-empty">
            <Icon name="pullRequest" size={24} />
            <p>Pick a pull request to see its summary and code.</p>
          </div>
        )}
      </div>
    </section>
  );
}
