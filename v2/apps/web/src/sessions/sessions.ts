import type {
  PermissionMode,
  RuntimeProjection,
  TerminalProjection,
  ThreadActivityProjection,
  ThreadMessageProjection,
  ThreadProjection,
} from "@zli-v2/contracts";

import { providerDisplayName } from "../agent/providers.js";
import { shallowArrayEqual } from "../runtime/runtimeStore.js";
import type { RunStart } from "./bestOf.js";
import type { FirstMessageFile } from "./handoff.js";

export type SessionMode = "terminal" | "chat";

export type SessionStatus = "preparing" | "starting" | "working" | "waiting" | "ready" | "ended" | "failed";

/** A launch that is waiting for its worktree to finish creating. */
export type PendingLaunch = {
  sessionId: string;
  worktreeId: string;
  provider: string;
  mode: SessionMode;
  model?: string;
  permissionMode?: PermissionMode;
  shareWorktree?: boolean;
  createdAt: string;
  errorMessage?: string;
  /** The start command was accepted; the entry stays until the terminal or thread is projected. */
  started?: boolean;
  /** First message for the agent, moved to the workbench's delivery queue once the agent starts. */
  prompt?: string;
  /** Text that goes with the first message: attached in a chat, pasted after it in a terminal. */
  promptFile?: FirstMessageFile;
  /** A best-of run copies these files into its new worktree before the agent starts. */
  fork?: RunStart;
};

export type AgentSession = {
  sessionId: string;
  worktreeId: string;
  provider: string;
  /** Latest agent CLI terminal for this session. */
  terminal?: TerminalProjection;
  /** Latest structured chat thread for this session. */
  thread?: ThreadProjection;
  pending?: PendingLaunch;
  createdAt?: string;
  updatedAt?: string;
  status: SessionStatus;
  /** The view that was created most recently, used until the person picks one. */
  defaultMode: SessionMode;
};

type Builder = Omit<AgentSession, "status" | "defaultMode"> & { order: number; lastKind?: SessionMode };

/**
 * Agent terminals and chat threads that share a sessionId are one session.
 * Records created before sessions existed stand alone under their own id.
 */
export function deriveSessions(
  projection: Pick<RuntimeProjection, "terminals" | "threads">,
  pending: readonly PendingLaunch[] = [],
): AgentSession[] {
  const sessions = new Map<string, Builder>();
  let order = 0;
  const touch = (sessionId: string, worktreeId: string, provider: string): Builder => {
    let entry = sessions.get(sessionId);
    if (!entry) {
      entry = { sessionId, worktreeId, provider, order: order++ };
      sessions.set(sessionId, entry);
    }
    return entry;
  };
  for (const terminal of projection.terminals) {
    if (terminal.kind !== "agent" || !terminal.agent) continue;
    const entry = touch(terminal.sessionId ?? terminal.terminalId, terminal.worktreeId, terminal.agent.provider);
    entry.terminal = terminal;
    entry.lastKind = "terminal";
    mergeTimes(entry, terminal.createdAt, terminal.updatedAt);
  }
  for (const thread of projection.threads) {
    const entry = touch(thread.sessionId ?? thread.threadId, thread.worktreeId, thread.provider);
    entry.thread = thread;
    if (!entry.lastKind || !entry.terminal || isLater(thread.createdAt, entry.terminal.createdAt)) {
      entry.lastKind = "chat";
    }
    mergeTimes(entry, thread.createdAt, thread.updatedAt);
  }
  for (const launch of pending) {
    if (sessions.has(launch.sessionId)) continue;
    const entry = touch(launch.sessionId, launch.worktreeId, launch.provider);
    entry.pending = launch;
    entry.lastKind = launch.mode;
    mergeTimes(entry, launch.createdAt, launch.createdAt);
  }
  return [...sessions.values()]
    .sort((left, right) => left.order - right.order)
    .map(({ order: _order, lastKind, ...session }) => ({
      ...session,
      status: sessionStatus(session),
      defaultMode: lastKind ?? "chat",
    }));
}

function mergeTimes(entry: Builder, createdAt: string | undefined, updatedAt: string | undefined): void {
  if (createdAt && (!entry.createdAt || createdAt < entry.createdAt)) entry.createdAt = createdAt;
  if (updatedAt && (!entry.updatedAt || updatedAt > entry.updatedAt)) entry.updatedAt = updatedAt;
}

function isLater(left: string | undefined, right: string | undefined): boolean {
  if (!left) return false;
  if (!right) return true;
  return left > right;
}

export function sessionStatus(session: Pick<AgentSession, "terminal" | "thread" | "pending">): SessionStatus {
  const { terminal, thread, pending } = session;
  if (!terminal && !thread) return pending?.errorMessage ? "failed" : "preparing";
  if (thread?.status === "waiting") return "waiting";
  if (thread?.status === "working") return "working";
  if (thread?.status === "starting" || terminal?.status === "starting") return "starting";
  const terminalLive = terminal?.status === "running";
  const threadLive = thread?.status === "idle";
  if (terminalLive || threadLive) return "ready";
  if (terminal?.status === "failed" || thread?.status === "failed") return "failed";
  return "ended";
}

export function sessionIsLive(session: Pick<AgentSession, "status">): boolean {
  return session.status !== "ended" && session.status !== "failed";
}

/** Commands that stop everything the session still runs: its agent CLI and its chat. */
export function sessionStopCommands(
  session: Pick<AgentSession, "terminal" | "thread">,
): ({ type: "terminal.stop"; terminalId: string } | { type: "thread.stop"; threadId: string })[] {
  const commands: ({ type: "terminal.stop"; terminalId: string } | { type: "thread.stop"; threadId: string })[] = [];
  const { terminal, thread } = session;
  if (terminal && (terminal.status === "running" || terminal.status === "starting")) {
    commands.push({ type: "terminal.stop", terminalId: terminal.terminalId });
  }
  if (thread && thread.status !== "stopped" && thread.status !== "failed") {
    commands.push({ type: "thread.stop", threadId: thread.threadId });
  }
  return commands;
}

export const sessionStatusLabel: Record<SessionStatus, string> = {
  preparing: "Preparing",
  starting: "Starting",
  working: "Working",
  waiting: "Needs input",
  ready: "Ready",
  ended: "Stopped",
  failed: "Failed",
};

export function sessionTitle(
  session: Pick<AgentSession, "thread" | "provider">,
  messages: readonly ThreadMessageProjection[] | undefined,
  providers: RuntimeProjection["providers"],
): string {
  const threadId = session.thread?.threadId;
  const first = threadId
    ? messages?.find((message) => message.threadId === threadId && message.role === "user" && message.text.trim())
    : undefined;
  if (first) {
    const line = first.text.trim().split(/\r?\n/u)[0] ?? "";
    return line.length > 72 ? `${line.slice(0, 71)}…` : line;
  }
  return providerDisplayName(session.provider, providers);
}

/** Compact age for sidebar rows: now, 5m, 3h, 2d, then a short date. */
export function relativeTime(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export type TimelineItem =
  | { kind: "message"; message: ThreadMessageProjection }
  | { kind: "work"; turnId: string; activities: ThreadActivityProjection[]; changedFiles: string[] };

/**
 * Messages in order, with each turn's tool calls folded into one work group placed
 * just before that turn's reply. Turns still running have no reply yet, so their
 * work groups go at the end.
 */
/**
 * Orders a thread's messages and work logs. Items equal to ones in `previous` are returned as the
 * same objects, so memoized rows skip re-rendering while one message streams in.
 */
export function buildTimeline(
  messages: readonly ThreadMessageProjection[],
  activities: readonly ThreadActivityProjection[],
  previous: readonly TimelineItem[] = [],
): TimelineItem[] {
  const previousWork = new Map<string, Extract<TimelineItem, { kind: "work" }>>();
  const previousMessages = new Map<ThreadMessageProjection, TimelineItem>();
  for (const item of previous) {
    if (item.kind === "work") previousWork.set(item.turnId, item);
    else previousMessages.set(item.message, item);
  }
  const byTurn = new Map<string, ThreadActivityProjection[]>();
  for (const activity of activities) {
    const key = activity.turnId ?? "";
    const list = byTurn.get(key) ?? [];
    list.push(activity);
    byTurn.set(key, list);
  }
  const placed = new Set<string>();
  const items: TimelineItem[] = [];
  const pushWork = (turnId: string) => {
    const list = byTurn.get(turnId);
    if (!list || placed.has(turnId)) return;
    placed.add(turnId);
    const earlier = previousWork.get(turnId);
    if (earlier && shallowArrayEqual(earlier.activities, list)) items.push(earlier);
    else items.push({ kind: "work", turnId, activities: list, changedFiles: changedFiles(list) });
  };
  for (const message of messages) {
    if (message.role === "assistant" && message.turnId) pushWork(message.turnId);
    items.push(previousMessages.get(message) ?? { kind: "message", message });
  }
  for (const turnId of byTurn.keys()) pushWork(turnId);
  return items;
}

export function changedFiles(activities: readonly ThreadActivityProjection[]): string[] {
  const files: string[] = [];
  for (const activity of activities) {
    if (activity.kind !== "file-edit" || activity.status === "failed") continue;
    for (const file of activity.files ?? []) if (!files.includes(file)) files.push(file);
  }
  return files;
}

/** Columns for n tiles: one, then two across, then three, capped at four. */
export function gridColumns(count: number): number {
  if (count <= 1) return 1;
  if (count <= 4) return 2;
  if (count <= 9) return 3;
  return 4;
}

/** Narrower than this, a terminal wraps most lines and a chat reads one word per line. */
export const MIN_TILE_WIDTH = 380;
const GRID_GAP = 8;

/**
 * Columns for n tiles in a grid `width` pixels wide. Tiles that would fall under the minimum width
 * stack into more rows instead, so opening a side panel does not squeeze every agent into a sliver.
 */
export function gridLayout(count: number, width: number | undefined): { columns: number; rows: number } {
  const fit = width ? Math.max(1, Math.floor((width + GRID_GAP) / (MIN_TILE_WIDTH + GRID_GAP))) : Infinity;
  const columns = Math.max(1, Math.min(gridColumns(count), fit));
  return { columns, rows: Math.max(1, Math.ceil(count / columns)) };
}
