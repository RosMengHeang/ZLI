import type { ProjectProjection } from "@zli-v2/contracts";
import { type MouseEvent, type ReactNode, useEffect, useState } from "react";

import type { AgentSession } from "../sessions/sessions.js";
import { IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { MenuButton, type MenuItem } from "../ui/Menu.js";
import { ZliLogo } from "../ui/ZliLogo.js";
import { railBadge, railTileLabels, splitActive } from "./sidebarStages.js";

export type ProjectRailProps = {
  /** In the order they list: pinned first. */
  projects: readonly ProjectProjection[];
  /** The project the person is working in. The panel follows it. */
  currentProjectId: string | undefined;
  /** The agent on screen. Going to an agent brings the panel back to its project. */
  activeSessionId: string | undefined;
  /** Every agent in the project, best-of runs and sub-agents included, for the live counts. */
  projectSessions(project: ProjectProjection): readonly AgentSession[];
  /** The agents that list at the top level of the project. */
  topAgents(project: ProjectProjection): readonly AgentSession[];
  /** Running, needs the person, is selected, or has running work nested under it. */
  isActive(agent: AgentSession): boolean;
  /** Asking, failed, or held back by its pull request, itself or in the work nested under it. */
  needsPerson(agent: AgentSession): boolean;
  renderAgent(agent: AgentSession, project: ProjectProjection): ReactNode;
  /** Worktrees without agents and best-of groups with no chat to sit under. */
  renderProjectExtras(project: ProjectProjection): ReactNode;
  renderProjectRename(project: ProjectProjection): ReactNode;
  renamingProjectId: string | undefined;
  projectContextItems(project: ProjectProjection): MenuItem[];
  openContextMenu(event: MouseEvent<HTMLElement>, label: string, items: () => MenuItem[]): void;
  onNewAgent(project?: ProjectProjection): void;
  onCreateWorktree(project?: ProjectProjection): void;
  onOpenProject(): void;
  /** Search, Usage, Settings, and Help, on the strip. */
  railActions: ReactNode;
  /** Plan limits and the runtime status, at the foot of the panel. */
  panelFoot: ReactNode;
};

/** A strip of projects with live counts, and a panel listing one project's agents, most urgent first. */
export function ProjectRail({
  projects,
  currentProjectId,
  activeSessionId,
  projectSessions,
  topAgents,
  isActive,
  needsPerson,
  renderAgent,
  renderProjectExtras,
  renderProjectRename,
  renamingProjectId,
  projectContextItems,
  openContextMenu,
  onNewAgent,
  onCreateWorktree,
  onOpenProject,
  railActions,
  panelFoot,
}: ProjectRailProps) {
  const [shownProjectId, setShownProjectId] = useState(currentProjectId);
  const [earlierOpenFor, setEarlierOpenFor] = useState<string>();

  // The panel follows the work. Clicking a tile only changes what the panel shows, until the work moves again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: going to another agent in the same project moves the work too.
  useEffect(() => {
    if (currentProjectId) setShownProjectId(currentProjectId);
  }, [currentProjectId, activeSessionId]);

  const project = projects.find((entry) => entry.projectId === shownProjectId) ?? projects[0];
  const agents = project ? topAgents(project) : [];
  const { active, recent, earlier } = splitActive(agents, isActive);
  // What needs the person comes first. Its amber or red second line says why, so it needs no heading.
  const ordered = [...active.filter(needsPerson), ...active.filter((agent) => !needsPerson(agent))];
  const earlierOpen = project !== undefined && earlierOpenFor === project.projectId;
  const tileLabels = railTileLabels(projects.map((entry) => entry.name));

  return (
    <div className="rail-layout">
      <nav className="rail" aria-label="Projects">
        <div className="rail-logo">
          <ZliLogo className="brand-mark" />
        </div>
        <div className="rail-projects">
          {projects.map((entry, index) => {
            const badge = railBadge(projectSessions(entry));
            const shown = entry.projectId === project?.projectId;
            const counts = badge ? `, ${badge.count} ${badge.tone}` : "";
            const label = tileLabels[index] ?? "";
            return (
              <button
                className={`rail-tile${shown ? " is-current" : ""}${Array.from(label).length > 1 ? " is-pair" : ""}`}
                type="button"
                key={entry.projectId}
                aria-label={`${entry.name}${counts}`}
                aria-current={shown ? "true" : undefined}
                data-tooltip={`${entry.name}${counts}`}
                onClick={() => setShownProjectId(entry.projectId)}
                onContextMenu={(event) =>
                  openContextMenu(event, `${entry.name} actions`, () => projectContextItems(entry))
                }
              >
                <span aria-hidden="true">{label}</span>
                {/* A dot says there is news. The count stays in the tile's name and tooltip. */}
                {badge ? <span className={`rail-badge is-${badge.tone}`} aria-hidden="true" /> : null}
              </button>
            );
          })}
          <IconButton label="Add project" icon="plus" onClick={onOpenProject} />
        </div>
        <div className="rail-actions">{railActions}</div>
      </nav>
      <div className="rail-panel">
        {project ? (
          <>
            <div className="rail-panel-head">
              {renamingProjectId === project.projectId ? (
                renderProjectRename(project)
              ) : (
                <MenuButton
                  className="rail-project-menu"
                  label={`${project.name} actions`}
                  tooltip={project.path}
                  icon="chevronDown"
                  items={() => projectContextItems(project)}
                >
                  <span className="rail-project-name">{project.name}</span>
                </MenuButton>
              )}
              <IconButton
                label="Create worktree"
                tooltip={
                  project.git === false ? "Worktrees need Git. This folder is not a Git repository." : "New worktree"
                }
                icon="branch"
                size="xs"
                iconSize={13}
                disabled={project.git === false}
                onClick={() => onCreateWorktree(project)}
              />
              <IconButton
                label={`New agent in ${project.name}`}
                tooltip="New agent here"
                icon="agentNew"
                size="xs"
                iconSize={13}
                onClick={() => onNewAgent(project)}
              />
            </div>
            <div className="sidebar-scroll rail-scroll">
              <section className="sidebar-project" aria-label={project.name} data-project-id={project.projectId}>
                {agents.length === 0 ? (
                  <p className="sidebar-note rail-note">
                    No agents yet.{" "}
                    <button
                      className="sidebar-note-action"
                      type="button"
                      aria-label={`Start an agent in ${project.name}`}
                      onClick={() => onNewAgent(project)}
                    >
                      Start one
                    </button>
                  </p>
                ) : null}
                {ordered.length > 0 ? (
                  <ul className="session-list">{ordered.map((agent) => renderAgent(agent, project))}</ul>
                ) : null}
                {recent.length > 0 ? (
                  <>
                    <h2 className="sidebar-heading rail-heading">Recent</h2>
                    <ul className="session-list">{recent.map((agent) => renderAgent(agent, project))}</ul>
                  </>
                ) : null}
                {earlier.length > 0 ? (
                  <div className="worktree-heading">
                    <button
                      className="worktree-toggle"
                      type="button"
                      aria-expanded={earlierOpen}
                      onClick={() => setEarlierOpenFor(earlierOpen ? undefined : project.projectId)}
                    >
                      <Icon name="chevronRight" size={11} className="worktree-toggle-chevron" />
                      {earlier.length === 1 ? "1 earlier agent" : `${earlier.length} earlier agents`}
                    </button>
                  </div>
                ) : null}
                {earlierOpen ? (
                  <ul className="session-list">{earlier.map((agent) => renderAgent(agent, project))}</ul>
                ) : null}
                {renderProjectExtras(project)}
              </section>
            </div>
          </>
        ) : (
          <div className="sidebar-scroll rail-scroll">
            <div className="sidebar-empty">
              <p>
                Add a Git repository to start. Each agent gets its own terminal, and its own worktree if you want one.
              </p>
              <button className="sidebar-note-action" type="button" onClick={onOpenProject}>
                Add a project
              </button>
            </div>
          </div>
        )}
        {panelFoot}
      </div>
    </div>
  );
}
