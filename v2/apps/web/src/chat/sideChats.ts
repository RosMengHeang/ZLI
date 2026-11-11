import { useSyncExternalStore } from "react";

/**
 * Side questions: short chats that read a chat's conversation but never write back to it. Their sessions stay
 * out of the sidebar and the board; the chat that asked shows them in its side panel. Kept on this machine so a
 * reload does not turn a side question into a chat of its own.
 */
const STORAGE_KEY = "zli.chat.sides";

let cache: Set<string> | undefined;
let snapshot: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function read(): Set<string> {
  if (cache) return cache;
  const ids = new Set<string>();
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    if (Array.isArray(raw)) for (const id of raw) if (typeof id === "string") ids.add(id);
  } catch {
    // A broken list forgets the side questions; their sessions then show as chats, which loses nothing.
  }
  cache = ids;
  snapshot = new Set(ids);
  return ids;
}

function write(ids: Set<string>): void {
  cache = ids;
  snapshot = new Set(ids);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids].slice(-200)));
  } catch {
    // Storage can be unavailable; the list holds until the window closes.
  }
  for (const listener of listeners) listener();
}

export function markSideChat(sessionId: string): void {
  const ids = new Set(read());
  ids.add(sessionId);
  write(ids);
}

export function forgetSideChat(sessionId: string): void {
  const ids = new Set(read());
  if (ids.delete(sessionId)) write(ids);
}

export function isSideChat(sessionId: string): boolean {
  return typeof window !== "undefined" && read().has(sessionId);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSideChatIds(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribe,
    () => {
      read();
      return snapshot;
    },
    () => snapshot,
  );
}
