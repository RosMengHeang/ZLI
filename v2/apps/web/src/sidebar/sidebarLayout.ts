import { useCallback, useState } from "react";

const STORAGE_KEY = "zli.sidebar.collapsed";

/**
 * Project ids whose folder the person closed, and ids whose "worktrees without agents" row they opened.
 * That row starts folded, so only the open ones are stored. Pinned project ids list first in the sidebar,
 * and pinned chat ids list above every project.
 */
export type SidebarCollapsed = { projects: string[]; idle: string[]; pinned: string[]; chats: string[] };

const ids = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

export function parseSidebarCollapsed(raw: string | null): SidebarCollapsed {
  try {
    const value: unknown = JSON.parse(raw ?? "{}");
    if (typeof value !== "object" || value === null) return { projects: [], idle: [], pinned: [], chats: [] };
    const record = value as Record<string, unknown>;
    return {
      projects: ids(record.projects),
      idle: ids(record.idle),
      pinned: ids(record.pinned),
      chats: ids(record.chats),
    };
  } catch {
    return { projects: [], idle: [], pinned: [], chats: [] };
  }
}

function read(): SidebarCollapsed {
  try {
    return parseSidebarCollapsed(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return { projects: [], idle: [], pinned: [], chats: [] };
  }
}

function write(next: SidebarCollapsed): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage can be full or blocked; the sidebar still works for this window.
  }
}

const BRANCHES_PROJECT_KEY = "zli.sidebar.branchesProject";

/**
 * How the sidebar arranges the work. The tree is the only one in use. Branches and Project rail are parked: their
 * code stays, and tests still cover it, but nothing in the app picks them.
 */
export type SidebarStyle = "tree" | "branches" | "rail";

/** The style the app shows. */
export const SIDEBAR_STYLE: SidebarStyle = "tree";

/** The project the Branches style is filtered to, remembered across restarts. Undefined means all of them. */
export function useBranchesProject() {
  const [projectId, setProjectId] = useState<string | undefined>(() => {
    try {
      return window.localStorage.getItem(BRANCHES_PROJECT_KEY) ?? undefined;
    } catch {
      return undefined;
    }
  });
  const choose = useCallback((next: string | undefined) => {
    setProjectId(next);
    try {
      if (next) window.localStorage.setItem(BRANCHES_PROJECT_KEY, next);
      else window.localStorage.removeItem(BRANCHES_PROJECT_KEY);
    } catch {
      // Storage can be full or blocked; the filter still works for this window.
    }
  }, []);
  return [projectId, choose] as const;
}

/** Which project folders are closed and which idle worktree rows are open, remembered across restarts. */
export function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(read);
  const toggle = useCallback((kind: keyof SidebarCollapsed, projectId: string) => {
    setCollapsed((current) => {
      const list = current[kind];
      const next = {
        ...current,
        [kind]: list.includes(projectId) ? list.filter((entry) => entry !== projectId) : [...list, projectId],
      };
      write(next);
      return next;
    });
  }, []);
  const expandProject = useCallback((projectId: string) => {
    setCollapsed((current) => {
      if (!current.projects.includes(projectId)) return current;
      const next = { ...current, projects: current.projects.filter((entry) => entry !== projectId) };
      write(next);
      return next;
    });
  }, []);
  return {
    expandProject,
    projectOpen: (projectId: string) => !collapsed.projects.includes(projectId),
    idleOpen: (projectId: string) => collapsed.idle.includes(projectId),
    pinned: (projectId: string) => collapsed.pinned.includes(projectId),
    toggleProject: (projectId: string) => toggle("projects", projectId),
    toggleIdle: (projectId: string) => toggle("idle", projectId),
    togglePinned: (projectId: string) => toggle("pinned", projectId),
    chatPinned: (sessionId: string) => collapsed.chats.includes(sessionId),
    toggleChatPinned: (sessionId: string) => toggle("chats", sessionId),
  };
}
