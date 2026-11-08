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
  /**
   * The tiles each project had open when its agents last left the board, by project id. Showing only that
   * project brings them back.
   */
  boards: Record<string, string[]>;
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
/** The agent grid keeps at least this much room beside the side panel and above the terminal drawer. */
export const MIN_GRID_WIDTH = 320;
export const MIN_GRID_HEIGHT = 160;

/**
 * The most a side panel or the drawer can take of the space it shares with the agent grid: all but the
 * grid's minimum. When the space cannot hold both minimums, they split it in proportion to them.
 */
export function roomBesideGrid(space: number, minimum: number, gridMinimum: number): number {
  const room = Math.max(0, Math.floor(space));
  return room >= minimum + gridMinimum ? room - gridMinimum : Math.floor((room * minimum) / (minimum + gridMinimum));
}

const initialState: WorkbenchState = {
  closed: [],
  boards: {},
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
    boards: pruneBoards(state.boards, (id) => id !== sessionId),
    pending: state.pending.filter((entry) => entry.sessionId !== sessionId),
    activeSessionId: state.activeSessionId === sessionId ? undefined : state.activeSessionId,
    maximizedSessionId: state.maximizedSessionId === sessionId ? undefined : state.maximizedSessionId,
  };
}

/** The project of each session whose worktree is known, in session order. Sub-agents belong to their worktree's project. */
export function sessionProjects(
  sessions: readonly { sessionId: string; worktreeId: string }[],
  worktrees: readonly { worktreeId: string; projectId: string }[],
): Map<string, string> {
  const projectOf = new Map(worktrees.map((worktree) => [worktree.worktreeId, worktree.projectId]));
  const result = new Map<string, string>();
  for (const session of sessions) {
    const projectId = projectOf.get(session.worktreeId);
    if (projectId !== undefined) result.set(session.sessionId, projectId);
  }
  return result;
}

function pruneBoards(
  boards: Record<string, string[]>,
  keep: (sessionId: string, projectId: string) => boolean,
): Record<string, string[]> {
  let changed = false;
  const next: Record<string, string[]> = {};
  for (const [projectId, ids] of Object.entries(boards)) {
    const kept = ids.filter((id) => keep(id, projectId));
    if (kept.length !== ids.length) changed = true;
    if (kept.length > 0) next[projectId] = kept;
  }
  return changed ? next : boards;
}

/**
 * Drops remembered tiles for sessions that are gone or now belong elsewhere, and boards for projects
 * that are no longer listed.
 */
export function forgetStaleBoards(
  state: WorkbenchState,
  projectOf: ReadonlyMap<string, string>,
  projectIds: ReadonlySet<string>,
): WorkbenchState {
  const boards = pruneBoards(
    state.boards,
    (sessionId, projectId) => projectIds.has(projectId) && projectOf.get(sessionId) === projectId,
  );
  return boards === state.boards ? state : { ...state, boards };
}

function projectSessionIds(projectOf: ReadonlyMap<string, string>, projectId: string): string[] {
  return [...projectOf].filter(([, owner]) => owner === projectId).map(([sessionId]) => sessionId);
}

/** Adds tiles to a project's remembered board, in session order, keeping the ones it already had. */
function remember(
  state: WorkbenchState,
  boards: Record<string, string[]>,
  projectOf: ReadonlyMap<string, string>,
  projectId: string,
  hidden: readonly string[],
): void {
  const kept = new Set([...(state.boards[projectId] ?? []), ...hidden]);
  boards[projectId] = projectSessionIds(projectOf, projectId).filter((id) => kept.has(id));
}

/** Puts every agent of the project back on the board. Returns `state` itself when all of them are open. */
export function openProjectAgents(
  state: WorkbenchState,
  projectOf: ReadonlyMap<string, string>,
  projectId: string,
): WorkbenchState {
  const ids = new Set(projectSessionIds(projectOf, projectId));
  if (!state.closed.some((id) => ids.has(id))) return state;
  const closed = state.closed.filter((id) => !ids.has(id));
  const { [projectId]: _board, ...boards } = state.boards;
  const activeOpen = state.activeSessionId !== undefined && !closed.includes(state.activeSessionId);
  return {
    ...state,
    closed,
    boards,
    activeSessionId: activeOpen ? state.activeSessionId : [...ids].at(-1),
    // A maximized tile would keep the tiles that just opened out of sight.
    maximizedSessionId: undefined,
  };
}

/**
 * Takes the project's tiles off the board and remembers them. The agents keep running. Returns `state`
 * itself when none of them are open.
 */
export function closeProjectAgents(
  state: WorkbenchState,
  projectOf: ReadonlyMap<string, string>,
  projectId: string,
): WorkbenchState {
  const open = projectSessionIds(projectOf, projectId).filter((id) => !state.closed.includes(id));
  if (open.length === 0) return state;
  const hidden = new Set(open);
  const boards = { ...state.boards };
  remember(state, boards, projectOf, projectId, open);
  return {
    ...state,
    closed: [...state.closed, ...open],
    boards,
    activeSessionId: hidden.has(state.activeSessionId ?? "") ? undefined : state.activeSessionId,
    maximizedSessionId: hidden.has(state.maximizedSessionId ?? "") ? undefined : state.maximizedSessionId,
  };
}

/**
 * Shows only the project's agents. Other projects' tiles leave the board and are remembered per project;
 * this project gets back the tiles it had open when it last left, or all of its agents when nothing is
 * remembered. Sessions without a project stay as they are. Returns `state` itself when nothing changes.
 */
export function focusProject(
  state: WorkbenchState,
  projectOf: ReadonlyMap<string, string>,
  projectId: string,
): WorkbenchState {
  const own = projectSessionIds(projectOf, projectId);
  const closed = new Set(state.closed);
  const remembered = new Set(state.boards[projectId] ?? []);
  const kept = own.filter((id) => !closed.has(id) || remembered.has(id));
  const shown = new Set(kept.length > 0 ? kept : own);
  if (shown.size === 0) return state;
  const hiddenBy = new Map<string, string[]>();
  for (const [sessionId, owner] of projectOf) {
    if (owner === projectId || closed.has(sessionId)) continue;
    hiddenBy.set(owner, [...(hiddenBy.get(owner) ?? []), sessionId]);
  }
  const hidden = [...hiddenBy.values()].flat();
  const reopened = state.closed.filter((id) => shown.has(id));
  const activeSessionId = shown.has(state.activeSessionId ?? "") ? state.activeSessionId : [...shown].at(-1);
  const maximizedSessionId = shown.has(state.maximizedSessionId ?? "") ? state.maximizedSessionId : undefined;
  if (
    hidden.length === 0 &&
    reopened.length === 0 &&
    activeSessionId === state.activeSessionId &&
    maximizedSessionId === state.maximizedSessionId
  ) {
    return state;
  }
  const { [projectId]: _board, ...boards } = state.boards;
  for (const [owner, ids] of hiddenBy) remember(state, boards, projectOf, owner, ids);
  return {
    ...state,
    closed: [...state.closed.filter((id) => !shown.has(id)), ...hidden],
    boards,
    activeSessionId,
    maximizedSessionId,
  };
}
/**
 * Whether a waiting launch still belongs on screen. It goes once its session exists. A failed launch can
 * only be tried again in its worktree, so it also goes when that worktree is gone, as after a reset
 * workspace, where it would otherwise stay on screen for good.
 */
export function keepPendingLaunch(
  launch: PendingLaunch,
  sessionIds: ReadonlySet<string>,
  worktreeIds: ReadonlySet<string>,
): boolean {
  if (sessionIds.has(launch.sessionId)) return false;
  return launch.errorMessage === undefined || worktreeIds.has(launch.worktreeId);
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

function boardChoices(value: unknown): Record<string, string[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const boards: Record<string, string[]> = {};
  for (const [projectId, ids] of Object.entries(value as Record<string, unknown>).slice(0, 200)) {
    const kept = strings(ids);
    if (kept.length > 0) boards[projectId] = kept;
  }
  return boards;
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
      boards: boardChoices(value.boards),
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
