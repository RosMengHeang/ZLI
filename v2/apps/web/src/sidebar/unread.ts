import { useCallback, useEffect, useRef, useState } from "react";

import type { AgentSession, SessionStatus } from "../sessions/sessions.js";

const STORAGE_KEY = "zli.sidebar.unread";

type Seen = Pick<AgentSession, "sessionId" | "status">;

const busy = new Set<SessionStatus>(["working", "waiting"]);
const starting = new Set<SessionStatus>(["preparing", "starting"]);

/**
 * Sessions whose agent finished, or failed, while the person was looking at something else. A session
 * joins when its turn ends away from view and leaves when it is opened, deleted, or set to work again.
 */
export function nextUnread(
  unread: ReadonlySet<string>,
  previous: ReadonlyMap<string, SessionStatus>,
  sessions: readonly Seen[],
  activeSessionId: string | undefined,
): ReadonlySet<string> {
  const next = new Set<string>();
  for (const session of sessions) {
    const before = previous.get(session.sessionId);
    const finished =
      before !== undefined && busy.has(before) && (session.status === "ready" || session.status === "failed");
    const failedToStart = before !== undefined && starting.has(before) && session.status === "failed";
    const still = unread.has(session.sessionId) && !busy.has(session.status);
    if (session.sessionId !== activeSessionId && (finished || failedToStart || still)) next.add(session.sessionId);
  }
  if (next.size === unread.size && [...next].every((id) => unread.has(id))) return unread;
  return next;
}

function read(): ReadonlySet<string> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
  } catch {
    return new Set();
  }
}

function write(unread: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...unread]));
  } catch {
    // Storage can be full or blocked; the marks still hold for this window.
  }
}

/** The unread sessions, remembered across restarts, and a way to mark all of them seen. */
export function useUnread(
  sessions: readonly Seen[],
  activeSessionId: string | undefined,
  /** False until the runtime has sent its sessions, so an empty first frame does not wipe the marks. */
  loaded: boolean,
): { unread: ReadonlySet<string>; clear(): void } {
  const [unread, setUnread] = useState(read);
  const previous = useRef<Map<string, SessionStatus>>(new Map());
  useEffect(() => {
    if (!loaded) return;
    const before = previous.current;
    previous.current = new Map(sessions.map((session) => [session.sessionId, session.status]));
    setUnread((current) => {
      const next = nextUnread(current, before, sessions, activeSessionId);
      if (next !== current) write(next);
      return next;
    });
  }, [sessions, activeSessionId, loaded]);
  const clear = useCallback(() => {
    setUnread((current) => {
      if (current.size === 0) return current;
      const next = new Set<string>();
      write(next);
      return next;
    });
  }, []);
  return { unread, clear };
}
