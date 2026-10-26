import { useCallback, useState } from "react";

const STORAGE_KEY = "zli.sidebar.collapsed";

/** Project ids whose folder, or whose Worktrees list, the person closed in the sidebar. */
export type SidebarCollapsed = { projects: string[]; worktrees: string[] };

const ids = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

export function parseSidebarCollapsed(raw: string | null): SidebarCollapsed {
  try {
    const value: unknown = JSON.parse(raw ?? "{}");
    if (typeof value !== "object" || value === null) return { projects: [], worktrees: [] };
    const record = value as Record<string, unknown>;
    return { projects: ids(record.projects), worktrees: ids(record.worktrees) };
  } catch {
    return { projects: [], worktrees: [] };
  }
}

function read(): SidebarCollapsed {
  try {
    return parseSidebarCollapsed(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return { projects: [], worktrees: [] };
  }
}

function write(next: SidebarCollapsed): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage can be full or blocked; the sidebar still works for this window.
  }
}

/** Which project folders and Worktrees lists are closed, remembered across restarts. */
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
    worktreesOpen: (projectId: string) => !collapsed.worktrees.includes(projectId),
    toggleProject: (projectId: string) => toggle("projects", projectId),
    toggleWorktrees: (projectId: string) => toggle("worktrees", projectId),
  };
}
