import { useSyncExternalStore } from "react";

/**
 * Archived chats, kept on this machine. An archived chat leaves its project's list for the Archived section at the
 * bottom of the sidebar; nothing about it is deleted. Chats archived by themselves, when their pull request
 * merged, are remembered too, so unarchiving one does not archive it again.
 */
const ARCHIVED_KEY = "zli.chat.archived";
const DECIDED_KEY = "zli.chat.archive-decided";
const MAX_REMEMBERED = 1_000;

type Store = { archived: Set<string>; decided: Set<string> };
let cache: Store | undefined;
let snapshot: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function readSet(key: string): Set<string> {
  try {
    const raw = JSON.parse(window.localStorage.getItem(key) ?? "[]") as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function read(): Store {
  if (cache) return cache;
  cache = { archived: readSet(ARCHIVED_KEY), decided: readSet(DECIDED_KEY) };
  snapshot = new Set(cache.archived);
  return cache;
}

function write(next: Store): void {
  cache = next;
  snapshot = new Set(next.archived);
  try {
    window.localStorage.setItem(ARCHIVED_KEY, JSON.stringify([...next.archived].slice(-MAX_REMEMBERED)));
    window.localStorage.setItem(DECIDED_KEY, JSON.stringify([...next.decided].slice(-MAX_REMEMBERED)));
  } catch {
    // Storage can be unavailable; the archive holds until the window closes.
  }
  for (const listener of listeners) listener();
}

export function setChatArchived(sessionId: string, archived: boolean): void {
  const store = read();
  const next = { archived: new Set(store.archived), decided: new Set(store.decided) };
  if (archived) next.archived.add(sessionId);
  else next.archived.delete(sessionId);
  next.decided.add(sessionId);
  write(next);
}

/** Archives the chat unless it was archived or unarchived before, by the person or by this. */
export function archiveChatOnce(sessionId: string): void {
  if (read().decided.has(sessionId)) return;
  setChatArchived(sessionId, true);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useArchivedChats(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribe,
    () => {
      read();
      return snapshot;
    },
    () => snapshot,
  );
}
