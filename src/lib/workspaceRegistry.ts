import type { Agent, AgentProviderId, ProjectInfo } from "../types";

export interface WorkspaceAgentResume {
  resumeId: string;
  name: string;
  provider: AgentProviderId;
  createWorktree: boolean;
}

export interface WorkspaceRecord {
  root: string;
  project: ProjectInfo;
  agents: WorkspaceAgentResume[];
}

export interface WorkspaceRegistry {
  activeProjectRoot: string | null;
  collapsed: boolean;
  expandedProjectRoots: string[];
  workspaces: WorkspaceRecord[];
}

export const DEFAULT_WORKSPACE_REGISTRY: WorkspaceRegistry = {
  activeProjectRoot: null,
  collapsed: false,
  expandedProjectRoots: [],
  workspaces: [],
};

export function workspaceRootKey(root: string): string {
  return root.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
}

export function agentBelongsToProject(agent: Agent, project: ProjectInfo): boolean {
  return workspaceRootKey(agent.projectRoot ?? agent.cwd) === workspaceRootKey(project.repositoryRoot || project.path);
}

function projectRoot(project: ProjectInfo): string {
  return project.repositoryRoot || project.path;
}

function includesRoot(roots: string[], root: string): boolean {
  const key = workspaceRootKey(root);
  return roots.some((candidate) => workspaceRootKey(candidate) === key);
}

export function upsertWorkspace(registry: WorkspaceRegistry, project: ProjectInfo): WorkspaceRegistry {
  const root = projectRoot(project);
  const index = registry.workspaces.findIndex((workspace) => workspaceRootKey(workspace.root) === workspaceRootKey(root));
  const existing = index >= 0 ? registry.workspaces[index] : null;
  const nextWorkspace: WorkspaceRecord = {
    root,
    project,
    agents: existing?.agents ?? [],
  };
  const workspaces = [...registry.workspaces];
  if (index >= 0) workspaces[index] = nextWorkspace;
  else workspaces.push(nextWorkspace);

  return {
    ...registry,
    activeProjectRoot: root,
    expandedProjectRoots: includesRoot(registry.expandedProjectRoots, root)
      ? registry.expandedProjectRoots
      : [...registry.expandedProjectRoots, root],
    workspaces,
  };
}

export function setWorkspaceActive(registry: WorkspaceRegistry, root: string): WorkspaceRegistry {
  const workspace = registry.workspaces.find((candidate) => workspaceRootKey(candidate.root) === workspaceRootKey(root));
  return workspace ? { ...registry, activeProjectRoot: workspace.root } : registry;
}

export function toggleWorkspaceExpanded(registry: WorkspaceRegistry, root: string): WorkspaceRegistry {
  return {
    ...registry,
    expandedProjectRoots: includesRoot(registry.expandedProjectRoots, root)
      ? registry.expandedProjectRoots.filter((candidate) => workspaceRootKey(candidate) !== workspaceRootKey(root))
      : [...registry.expandedProjectRoots, root],
  };
}

export function setWorkspaceCollapsed(registry: WorkspaceRegistry, collapsed: boolean): WorkspaceRegistry {
  return { ...registry, collapsed };
}

export function saveWorkspaceAgent(
  registry: WorkspaceRegistry,
  root: string,
  agent: WorkspaceAgentResume,
): WorkspaceRegistry {
  return {
    ...registry,
    workspaces: registry.workspaces.map((workspace) => {
      if (workspaceRootKey(workspace.root) !== workspaceRootKey(root)) return workspace;
      const index = workspace.agents.findIndex((candidate) => candidate.resumeId === agent.resumeId);
      const agents = [...workspace.agents];
      if (index >= 0) agents[index] = agent;
      else agents.push(agent);
      return { ...workspace, agents };
    }),
  };
}

export function forgetWorkspaceAgent(registry: WorkspaceRegistry, root: string, resumeId: string): WorkspaceRegistry {
  return {
    ...registry,
    workspaces: registry.workspaces.map((workspace) =>
      workspaceRootKey(workspace.root) !== workspaceRootKey(root)
        ? workspace
        : { ...workspace, agents: workspace.agents.filter((agent) => agent.resumeId !== resumeId) },
    ),
  };
}

export function normalizeWorkspaceRegistry(value: unknown): WorkspaceRegistry {
  if (!value || typeof value !== "object") return DEFAULT_WORKSPACE_REGISTRY;
  const input = value as Partial<WorkspaceRegistry>;
  const workspaces = Array.isArray(input.workspaces)
    ? input.workspaces.flatMap((candidate) => {
        if (!candidate || typeof candidate !== "object") return [];
        const record = candidate as Partial<WorkspaceRecord>;
        if (!record.root || !record.project || typeof record.project !== "object") return [];
        const agents = Array.isArray(record.agents)
          ? record.agents.flatMap((agent) => {
              if (!agent || typeof agent !== "object") return [];
              const item = agent as Partial<WorkspaceAgentResume>;
              return item.resumeId && item.name && item.provider
                ? [{
                    resumeId: item.resumeId,
                    name: item.name,
                    provider: item.provider,
                    createWorktree: Boolean(item.createWorktree),
                  }]
                : [];
            })
          : [];
        return [{ root: record.root, project: record.project, agents }];
      })
    : [];
  const expandedProjectRoots = Array.isArray(input.expandedProjectRoots)
    ? input.expandedProjectRoots.filter((root): root is string => typeof root === "string")
    : [];
  const activeProjectRoot = typeof input.activeProjectRoot === "string" &&
    workspaces.some((workspace) => workspaceRootKey(workspace.root) === workspaceRootKey(input.activeProjectRoot!))
    ? workspaces.find((workspace) => workspaceRootKey(workspace.root) === workspaceRootKey(input.activeProjectRoot!))!.root
    : (workspaces[0]?.root ?? null);

  return {
    activeProjectRoot,
    collapsed: Boolean(input.collapsed),
    expandedProjectRoots,
    workspaces,
  };
}
