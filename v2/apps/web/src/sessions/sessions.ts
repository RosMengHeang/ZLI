import {
  AgentName,
  agentNameTaken,
  type PermissionMode,
  type RuntimeProjection,
  type TerminalProjection,
  type ThreadActivityProjection,
  type ThreadMessageProjection,
  type ThreadProjection,
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
  accountId?: string;
  name?: string;
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
  /** The chat shown for this session: the one picked from its history, or else the latest. */
  thread?: ThreadProjection;
  /** Every chat this session has had, oldest first. */
  threads?: readonly ThreadProjection[];
  pending?: PendingLaunch;
  createdAt?: string;
  updatedAt?: string;
  status: SessionStatus;
  /**
   * How the agent runs, chosen once when it starts. Sessions from earlier versions could have both a
   * terminal and a chat; they show the one started last.
   */
  mode: SessionMode;
};

type Builder = Omit<AgentSession, "status" | "mode" | "threads"> & {
  order: number;
  lastKind?: SessionMode;
  threads?: ThreadProjection[];
};

/**
 * Agent terminals and chat threads that share a sessionId are one session.
 * Records created before sessions existed stand alone under their own id.
 */
export function deriveSessions(
  projection: Pick<RuntimeProjection, "terminals" | "threads">,
  pending: readonly PendingLaunch[] = [],
  /** The chat picked from each session's history, by session id. */
  chosenChats: Readonly<Record<string, string>> = {},
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
    entry.threads = [...(entry.threads ?? []), thread];
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
  for (const entry of sessions.values()) {
    const chosen = chosenChats[entry.sessionId];
    const thread = entry.threads?.find((candidate) => candidate.threadId === chosen) ?? entry.threads?.at(-1);
    if (thread) entry.thread = thread;
  }
  return [...sessions.values()]
    .sort((left, right) => left.order - right.order)
    .map(({ order: _order, lastKind, ...session }) => ({
      ...session,
      status: sessionStatus(session),
      mode: lastKind ?? "chat",
    }));
}

export type SessionChat = {
  threadId: string;
  title: string;
  updatedAt?: string | undefined;
  status: ThreadProjection["status"];
  current: boolean;
};

/** A session's chats for its history menu, newest first. A chat with nothing said in it yet is a New chat. */
export function sessionChats(
  session: Pick<AgentSession, "thread" | "threads" | "provider">,
  messages: readonly ThreadMessageProjection[] | undefined,
  providers: RuntimeProjection["providers"],
): SessionChat[] {
  const said = new Set(
    (messages ?? []).filter((message) => message.role === "user" && message.text.trim()).map((m) => m.threadId),
  );
  return [...(session.threads ?? [])].reverse().map((thread) => ({
    threadId: thread.threadId,
    title: said.has(thread.threadId)
      ? sessionTitle({ thread, provider: session.provider }, messages, providers)
      : "New chat",
    updatedAt: thread.updatedAt ?? thread.createdAt,
    status: thread.status,
    current: thread.threadId === session.thread?.threadId,
  }));
}

export const chatStatusLabel: Record<ThreadProjection["status"], string> = {
  starting: "Starting",
  idle: "Ready",
  working: "Working",
  waiting: "Needs input",
  stopped: "Stopped",
  failed: "Failed",
};

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

type NamedSession = Pick<AgentSession, "mode" | "terminal" | "thread">;

/** The terminal or chat that holds the session's name: the one its tile shows. */
function namedRecord(session: NamedSession): { id: string; name: string | undefined } | undefined {
  if (session.mode === "terminal") {
    return session.terminal ? { id: session.terminal.terminalId, name: session.terminal.name } : undefined;
  }
  return session.thread ? { id: session.thread.threadId, name: session.thread.name } : undefined;
}

/** The name the person gave the session's agent, if any. */
export function sessionAgentName(session: NamedSession & Pick<AgentSession, "pending">): string | undefined {
  const record = namedRecord(session);
  return record ? record.name : session.pending?.name;
}

/** The command that sets or clears the agent's name. Undefined while the agent has not started. */
export function sessionRenameCommand(
  session: NamedSession,
  name: string | null,
):
  | { type: "terminal.rename"; terminalId: string; name: string | null }
  | { type: "thread.rename"; threadId: string; name: string | null }
  | undefined {
  const record = namedRecord(session);
  if (!record) return undefined;
  return session.mode === "terminal"
    ? { type: "terminal.rename", terminalId: record.id, name }
    : { type: "thread.rename", threadId: record.id, name };
}

/**
 * Why a typed name can't be used, or undefined when it can. An empty name means no name.
 * `session` is the agent being renamed, which may keep its own name.
 */
export function agentNameProblem(
  projection: Pick<RuntimeProjection, "worktrees" | "threads" | "terminals">,
  projectId: string | undefined,
  name: string,
  session?: NamedSession,
): string | undefined {
  if (!name.trim()) return undefined;
  const parsed = AgentName.safeParse(name);
  if (!parsed.success) return parsed.error.issues[0]?.message ?? "This name can't be used.";
  const exceptId = session ? namedRecord(session)?.id : undefined;
  if (projectId && agentNameTaken(projection, { projectId, name: parsed.data, ...(exceptId ? { exceptId } : {}) })) {
    return `Another agent in this project is already called ${parsed.data}.`;
  }
  return undefined;
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
  /** `key` is set when the item is one part of a reply that tool calls split up. */
  | { kind: "message"; message: ThreadMessageProjection; key?: string }
  | {
      kind: "work";
      /** The first call's id, which stays the same while the group grows. */
      key: string;
      turnId: string;
      activities: ThreadActivityProjection[];
      /** Files the whole turn changed, on the turn's last group only. */
      changedFiles: string[];
    };

type WorkItem = Extract<TimelineItem, { kind: "work" }>;

/**
 * Orders a thread's messages and tool calls. A call that reports where it started in the reply
 * goes at that point, so the steps read in between the agent's text the way they happened. Calls
 * without that place go before the turn's reply, and turns with no reply yet put theirs at the end.
 *
 * Items equal to ones in `previous` are returned as the same objects, so memoized rows skip
 * re-rendering while one message streams in.
 */
export function buildTimeline(
  messages: readonly ThreadMessageProjection[],
  activities: readonly ThreadActivityProjection[],
  previous: readonly TimelineItem[] = [],
): TimelineItem[] {
  const previousWork = new Map<string, WorkItem>();
  const previousMessages = new Map<ThreadMessageProjection, TimelineItem>();
  const previousParts = new Map<string, Extract<TimelineItem, { kind: "message" }>>();
  for (const item of previous) {
    if (item.kind === "work") previousWork.set(item.key, item);
    else if (item.key) previousParts.set(item.key, item);
    else previousMessages.set(item.message, item);
  }
  const byTurn = new Map<string, ThreadActivityProjection[]>();
  for (const activity of activities) {
    const key = activity.turnId ?? "";
    const list = byTurn.get(key) ?? [];
    list.push(activity);
    byTurn.set(key, list);
  }
  const lastReply = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.role === "assistant" && message.turnId && byTurn.has(message.turnId))
      lastReply.set(message.turnId, index);
  });
  const filesByTurn = new Map<string, string[]>();
  for (const [turnId, list] of byTurn) filesByTurn.set(turnId, changedFiles(list));
  const lastGroup = new Map<string, number>();
  const items: TimelineItem[] = [];
  const pushWork = (turnId: string, list: ThreadActivityProjection[]) => {
    const first = list[0];
    if (!first) return;
    const key = first.activityId;
    lastGroup.set(turnId, items.length);
    items.push({ kind: "work", key, turnId, activities: list, changedFiles: [] });
  };
  const pushPart = (message: ThreadMessageProjection, start: number, end: number) => {
    const text = message.text.slice(start, end);
    if (!text.trim()) return;
    if (start === 0 && end >= message.text.length) {
      items.push(previousMessages.get(message) ?? { kind: "message", message });
      return;
    }
    const key = `${message.messageId}:${start}`;
    const earlier = previousParts.get(key);
    if (earlier && earlier.message.text === text) items.push(earlier);
    else items.push({ kind: "message", message: { ...message, text }, key });
  };
  /** Reply text already placed per turn. A turn's reply can arrive as more than one message. */
  const consumed = new Map<string, number>();
  messages.forEach((message, index) => {
    const turnId = message.role === "assistant" ? message.turnId : undefined;
    const queue = turnId ? byTurn.get(turnId) : undefined;
    if (!turnId || !queue) {
      items.push(previousMessages.get(message) ?? { kind: "message", message });
      return;
    }
    const base = consumed.get(turnId) ?? 0;
    const end = base + message.text.length;
    let cursor = base;
    while (queue.length > 0 && placeOf(queue[0]) < end) {
      const at = Math.max(placeOf(queue[0]), cursor);
      pushPart(message, cursor - base, at - base);
      cursor = at;
      const group: ThreadActivityProjection[] = [];
      while (queue.length > 0 && placeOf(queue[0]) <= cursor) group.push(queue.shift() as ThreadActivityProjection);
      pushWork(turnId, group);
    }
    pushPart(message, cursor - base, end - base);
    consumed.set(turnId, end);
    if (lastReply.get(turnId) === index) pushWork(turnId, queue.splice(0));
  });
  for (const [turnId, queue] of byTurn) pushWork(turnId, queue.splice(0));
  items.forEach((item, index) => {
    if (item.kind !== "work") return;
    const files = lastGroup.get(item.turnId) === index ? (filesByTurn.get(item.turnId) ?? []) : [];
    const earlier = previousWork.get(item.key);
    const same =
      earlier?.turnId === item.turnId &&
      shallowArrayEqual(earlier.activities, item.activities) &&
      shallowArrayEqual(earlier.changedFiles, files);
    items[index] = same && earlier ? earlier : { ...item, changedFiles: files };
  });
  return items;
}

function placeOf(activity: ThreadActivityProjection | undefined): number {
  return activity?.textOffset ?? 0;
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
 * When the tiles do not fill the last row, the first `tall` tiles span two rows so no cell is left
 * empty: three tiles become one tall tile beside two stacked ones.
 */
export function gridLayout(count: number, width: number | undefined): { columns: number; rows: number; tall: number } {
  const fit = width ? Math.max(1, Math.floor((width + GRID_GAP) / (MIN_TILE_WIDTH + GRID_GAP))) : Infinity;
  const columns = Math.max(1, Math.min(gridColumns(count), fit));
  const rows = Math.max(1, Math.ceil(count / columns));
  return { columns, rows, tall: rows > 1 ? columns * rows - count : 0 };
}
