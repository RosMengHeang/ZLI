import { useCallback, useState } from "react";

import type { PendingLaunch, SessionMode } from "./sessions.js";

const STORAGE_KEY = "zli.workbench.v1";

export type WorkbenchState = {
  /** Sessions removed from the grid. They stay in the sidebar and keep running. */
  closed: string[];
  /** Sessions removed from the sidebar list as well. */
  hidden: string[];
  modes: Record<string, SessionMode>;
  pending: PendingLaunch[];
  activeSessionId?: string | undefined;
  maximizedSessionId?: string | undefined;
  drawerOpen: boolean;
  drawerHeight: number;
  sidebarOpen: boolean;
};

export const DEFAULT_DRAWER_HEIGHT = 280;
export const MIN_DRAWER_HEIGHT = 140;

const initialState: WorkbenchState = {
  closed: [],
  hidden: [],
  modes: {},
  pending: [],
  drawerOpen: false,
  drawerHeight: DEFAULT_DRAWER_HEIGHT,
  sidebarOpen: true,
};

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").slice(-500) : [];
}

export function parseWorkbenchState(raw: string | null): WorkbenchState {
  if (!raw) return initialState;
  try {
    const value = JSON.parse(raw) as Partial<WorkbenchState>;
    const modes: Record<string, SessionMode> = {};
    for (const [key, mode] of Object.entries(value.modes ?? {})) {
      if (mode === "terminal" || mode === "chat") modes[key] = mode;
    }
    const pending = Array.isArray(value.pending)
      ? value.pending.filter(
          (entry): entry is PendingLaunch =>
            typeof entry === "object" &&
            entry !== null &&
            typeof entry.sessionId === "string" &&
            typeof entry.worktreeId === "string" &&
            typeof entry.provider === "string" &&
            (entry.mode === "terminal" || entry.mode === "chat"),
        )
      : [];
    return {
      closed: strings(value.closed),
      hidden: strings(value.hidden),
      modes,
      pending,
      ...(typeof value.activeSessionId === "string" ? { activeSessionId: value.activeSessionId } : {}),
      ...(typeof value.maximizedSessionId === "string" ? { maximizedSessionId: value.maximizedSessionId } : {}),
      drawerOpen: value.drawerOpen === true,
      drawerHeight:
        typeof value.drawerHeight === "number" && value.drawerHeight >= MIN_DRAWER_HEIGHT
          ? Math.round(value.drawerHeight)
          : DEFAULT_DRAWER_HEIGHT,
      sidebarOpen: value.sidebarOpen !== false,
    };
  } catch {
    return initialState;
  }
}

function load(): WorkbenchState {
  try {
    return parseWorkbenchState(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return initialState;
  }
}

/** Layout choices that belong to this window: open tiles, view modes, drawer size. */
export function useWorkbenchState(): [WorkbenchState, (update: (state: WorkbenchState) => WorkbenchState) => void] {
  const [state, setState] = useState(load);
  const update = useCallback((change: (state: WorkbenchState) => WorkbenchState) => {
    setState((previous) => {
      const next = change(previous);
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Storage can be unavailable; the layout still applies until the window closes.
      }
      return next;
    });
  }, []);
  return [state, update];
}
