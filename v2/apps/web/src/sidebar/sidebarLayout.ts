import { useCallback, useState } from "react";

const STORAGE_KEY = "zli.sidebar.collapsed";

/**
 * Project ids whose folder the person closed, and ids whose "worktrees without agents" row they opened.
 * That row starts folded, so only the open ones are stored.
 */
export type SidebarCollapsed = { projects: string[]; idle: string[] };

const ids = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

export function parseSidebarCollapsed(raw: string | null): SidebarCollapsed {
  try {
    const value: unknown = JSON.parse(raw ?? "{}");
    if (typeof value !== "object" || value === null) return { projects: [], idle: [] };
    const record = value as Record<string, unknown>;
    return { projects: ids(record.projects), idle: ids(record.idle) };
  } catch {
    return { projects: [], idle: [] };
  }
}

function read(): SidebarCollapsed {
  try {
    return parseSidebarCollapsed(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return { projects: [], idle: [] };
  }
}

function write(next: SidebarCollapsed): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage can be full or blocked; the sidebar still works for this window.
  }
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
  return {
    projectOpen: (projectId: string) => !collapsed.projects.includes(projectId),
    idleOpen: (projectId: string) => collapsed.idle.includes(projectId),
    toggleProject: (projectId: string) => toggle("projects", projectId),
    toggleIdle: (projectId: string) => toggle("idle", projectId),
  };
}
