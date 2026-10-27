import { useCallback, useState } from "react";

import { parseRunGroups, type RunGroup, withoutRun } from "./bestOf.js";
import type { FirstMessageFile } from "./handoff.js";
import type { PendingLaunch } from "./sessions.js";

const STORAGE_KEY = "zli.workbench.v1";

export type FirstMessage = {
  text: string;
  file?: FirstMessageFile;
  /** Chats the session already had. The message waits for a chat that is not one of them. */
  after?: string[];
};

export type WorkbenchState = {
  /** Sessions removed from the grid. They stay in the sidebar and keep running. */
  closed: string[];
  pending: PendingLaunch[];
  /** First messages waiting for their agent to be ready for input, by session. */
  firstMessages: Record<string, FirstMessage>;
  /** Best-of runs that are still being compared. */
  groups: RunGroup[];
  /** The earlier chat a session shows instead of its latest one, by session. */
  chats: Record<string, string>;
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
  pending: [],
  firstMessages: {},
  groups: [],
  chats: {},
  drawerOpen: false,
  drawerHeight: DEFAULT_DRAWER_HEIGHT,
  sidebarOpen: true,
};

/** Drops every layout trace of a session that no longer exists. */
export function forgetSession(state: WorkbenchState, sessionId: string): WorkbenchState {
  const { [sessionId]: _message, ...firstMessages } = state.firstMessages;
  const { [sessionId]: _chat, ...chats } = state.chats;
  return {
    ...state,
    firstMessages,
    chats,
    groups: withoutRun(state.groups, sessionId),
    closed: state.closed.filter((id) => id !== sessionId),
    pending: state.pending.filter((entry) => entry.sessionId !== sessionId),
    activeSessionId: state.activeSessionId === sessionId ? undefined : state.activeSessionId,
    maximizedSessionId: state.maximizedSessionId === sessionId ? undefined : state.maximizedSessionId,
  };
}

/** Earlier versions stored the first message as a bare string. */
function parseFirstMessage(value: unknown): FirstMessage | undefined {
  if (typeof value === "string") return value.length > 0 ? { text: value } : undefined;
  if (typeof value !== "object" || value === null) return undefined;
  const { text, file, after } = value as { text?: unknown; file?: unknown; after?: unknown };
  if (typeof text !== "string" || text.length === 0) return undefined;
  const { name, text: body } = (file ?? {}) as { name?: unknown; text?: unknown };
  const earlier = strings(after);
  return {
    text,
    ...(typeof name === "string" && typeof body === "string" ? { file: { name, text: body } } : {}),
    ...(earlier.length > 0 ? { after: earlier } : {}),
  };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").slice(-500) : [];
}

function chatChoices(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .slice(0, 500),
  );
}

export function parseWorkbenchState(raw: string | null): WorkbenchState {
  if (!raw) return initialState;
  try {
    const value = JSON.parse(raw) as Partial<WorkbenchState>;
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
      pending,
      firstMessages,
      groups: parseRunGroups(value.groups),
      chats: chatChoices(value.chats),
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

/** Layout choices that belong to this window: open tiles, drawer size. */
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
