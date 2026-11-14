import { useSyncExternalStore } from "react";

import { BUDDY_BODIES, type Buddy, type BuddyBody, buddyBody, parseBuddy } from "./buddies.js";

/**
 * Which buddy each chat wears, kept on this machine. A chat gets one the first time the sidebar lists it,
 * picked so the chats near it look different, and keeps it for good: switching agent or model never changes it.
 * The key predates buddies; animals stored under it map to the matching buddy when read.
 */
const STORAGE_KEY = "zli.chat.animals";
const MAX_REMEMBERED = 500;

let cache: Record<string, Buddy> | undefined;
const listeners = new Set<() => void>();

function read(): Record<string, Buddy> {
  if (cache) return cache;
  const parsed: Record<string, Buddy> = {};
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [id, value] of Object.entries(raw)) {
        const buddy = parseBuddy(value);
        if (buddy) parsed[id] = buddy;
      }
    }
  } catch {
    // A broken entry starts the list over; chats fall back to their hashed buddy until assigned again.
  }
  cache = parsed;
  return parsed;
}

function write(next: Record<string, Buddy>): void {
  const ids = Object.keys(next);
  const kept =
    ids.length > MAX_REMEMBERED ? Object.fromEntries(ids.slice(-MAX_REMEMBERED).map((id) => [id, next[id]])) : next;
  cache = kept as Record<string, Buddy>;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(kept));
  } catch {
    // Storage can be unavailable; the buddies still hold until the window closes.
  }
  for (const listener of listeners) listener();
}

/** The buddy a chat id hashes to, used before the chat has one of its own. */
export function hashedBuddy(chatId: string): Buddy {
  let hash = 0;
  for (let index = 0; index < chatId.length; index += 1) hash = (hash * 31 + chatId.charCodeAt(index)) >>> 0;
  return BUDDY_BODIES[hash % BUDDY_BODIES.length] ?? "gumdrop";
}

export function storedChatBuddy(chatId: string): Buddy | undefined {
  return read()[chatId];
}

/**
 * Gives every chat in `chatIds` (newest last) a buddy if it has none. A new chat takes the body used least
 * among the chats listed, preferring its hashed one on a tie, so neighbours rarely match.
 */
export function assignChatBuddies(chatIds: readonly string[]): void {
  const known = read();
  const missing = chatIds.filter((id) => !known[id]);
  if (missing.length === 0) return;
  const next = { ...known };
  const counts = new Map<BuddyBody, number>(BUDDY_BODIES.map((body) => [body, 0]));
  for (const id of chatIds) {
    const buddy = next[id];
    if (buddy) counts.set(buddyBody(buddy), (counts.get(buddyBody(buddy)) ?? 0) + 1);
  }
  for (const id of missing) {
    const fewest = Math.min(...counts.values());
    const preferred = buddyBody(hashedBuddy(id));
    const body =
      (counts.get(preferred) ?? 0) === fewest
        ? preferred
        : (BUDDY_BODIES.find((candidate) => (counts.get(candidate) ?? 0) === fewest) ?? preferred);
    next[id] = body;
    counts.set(body, (counts.get(body) ?? 0) + 1);
  }
  write(next);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    cache = undefined;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The chat's buddy: the one it was given, or its hashed one until then. */
export function useChatBuddy(chatId: string): Buddy {
  const stored = useSyncExternalStore(
    subscribe,
    () => read()[chatId],
    () => undefined,
  );
  return stored ?? hashedBuddy(chatId);
}
