import { useCallback, useState } from "react";

import type { FirstMessageFile } from "./handoff.js";
import type { PendingLaunch, SessionMode } from "./sessions.js";

const STORAGE_KEY = "zli.workbench.v1";

export type FirstMessage = { text: string; file?: FirstMessageFile };

export type WorkbenchState = {
  /** Sessions removed from the grid. They stay in the sidebar and keep running. */
  closed: string[];
  modes: Record<string, SessionMode>;
  pending: PendingLaunch[];
  /** First messages waiting for their agent to be ready for input, by session. */
  firstMessages: Record<string, FirstMessage>;
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
  modes: {},
  pending: [],
  firstMessages: {},
  drawerOpen: false,
  drawerHeight: DEFAULT_DRAWER_HEIGHT,
  sidebarOpen: true,
};

/** Drops every layout trace of a session that no longer exists. */
export function forgetSession(state: WorkbenchState, sessionId: string): WorkbenchState {
  const { [sessionId]: _mode, ...modes } = state.modes;
  const { [sessionId]: _message, ...firstMessages } = state.firstMessages;
  return {
    ...state,
    firstMessages,
    closed: state.closed.filter((id) => id !== sessionId),
    pending: state.pending.filter((entry) => entry.sessionId !== sessionId),
    modes,
    activeSessionId: state.activeSessionId === sessionId ? undefined : state.activeSessionId,
    maximizedSessionId: state.maximizedSessionId === sessionId ? undefined : state.maximizedSessionId,
  };
}

/** Earlier versions stored the first message as a bare string. */
function parseFirstMessage(value: unknown): FirstMessage | undefined {
  if (typeof value === "string") return value.length > 0 ? { text: value } : undefined;
  if (typeof value !== "object" || value === null) return undefined;
  const { text, file } = value as { text?: unknown; file?: unknown };
  if (typeof text !== "string" || text.length === 0) return undefined;
  const { name, text: body } = (file ?? {}) as { name?: unknown; text?: unknown };
  return typeof name === "string" && typeof body === "string" ? { text, file: { name, text: body } } : { text };
}

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
    const firstMessages: Record<string, FirstMessage> = {};
    for (const [key, entry] of Object.entries((value.firstMessages ?? {}) as Record<string, unknown>).slice(0, 50)) {
      const message = parseFirstMessage(entry);
      if (message) firstMessages[key] = message;
    }
    return {
      closed: strings(value.closed),
      modes,
      pending,
      firstMessages,
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
