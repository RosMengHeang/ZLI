import { create } from "zustand";
import {
  DEFAULT_WORKSPACE_REGISTRY,
  forgetWorkspaceAgent,
  forgetWorkspaceAgents,
  normalizeWorkspaceRegistry,
  saveWorkspaceAgent,
  setWorkspaceActive,
  setWorkspaceCollapsed,
  toggleWorkspaceExpanded,
  upsertWorkspace,
  type WorkspaceAgentResume,
  type WorkspaceRecord,
  type WorkspaceRegistry,
  workspaceRootKey,
} from "../lib/workspaceRegistry";
import type { ProjectInfo } from "../types";

const WORKSPACE_REGISTRY_KEY = "taxzy:workspace-registry";

function readRegistry(): WorkspaceRegistry {
  try {
    const raw = localStorage.getItem(WORKSPACE_REGISTRY_KEY);
    return raw ? normalizeWorkspaceRegistry(JSON.parse(raw)) : DEFAULT_WORKSPACE_REGISTRY;
  } catch {
    return DEFAULT_WORKSPACE_REGISTRY;
  }
}

function persistRegistry(registry: WorkspaceRegistry): void {
  try {
    localStorage.setItem(WORKSPACE_REGISTRY_KEY, JSON.stringify(registry));
  } catch {
    /* Storage can be unavailable in private or restricted webviews. */
  }
}

interface WorkspaceState extends WorkspaceRegistry {
  rememberProject: (project: ProjectInfo) => void;
  setActiveProject: (root: string) => void;
  toggleExpanded: (root: string) => void;
  setCollapsed: (collapsed: boolean) => void;
  saveAgent: (root: string, agent: WorkspaceAgentResume) => void;
  forgetAgent: (root: string, resumeId: string) => void;
  forgetAgents: (root: string, resumeIds: string[]) => void;
  getWorkspace: (root: string) => WorkspaceRecord | undefined;
}

const initial = readRegistry();

export const useWorkspaceStore = create<WorkspaceState>((set, get) => {
  const update = (next: WorkspaceRegistry): void => {
    persistRegistry(next);
    set(next);
  };

  return {
    ...initial,
    rememberProject: (project) => update(upsertWorkspace(get(), project)),
    setActiveProject: (root) => update(setWorkspaceActive(get(), root)),
    toggleExpanded: (root) => update(toggleWorkspaceExpanded(get(), root)),
    setCollapsed: (collapsed) => update(setWorkspaceCollapsed(get(), collapsed)),
    saveAgent: (root, agent) => update(saveWorkspaceAgent(get(), root, agent)),
    forgetAgent: (root, resumeId) => update(forgetWorkspaceAgent(get(), root, resumeId)),
    forgetAgents: (root, resumeIds) => update(forgetWorkspaceAgents(get(), root, resumeIds)),
    getWorkspace: (root) => get().workspaces.find((workspace) => workspaceRootKey(workspace.root) === workspaceRootKey(root)),
  };
});
