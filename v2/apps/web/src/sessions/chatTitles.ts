import { useSyncExternalStore } from "react";

/**
 * Titles the person gave their chats, kept on this machine. A chat without one is named by its first message;
 * clearing a title goes back to that.
 */
const STORAGE_KEY = "zli.chat.titles";
const MAX_TITLE = 120;
const MAX_REMEMBERED = 500;

let cache: Record<string, string> | undefined;
let version = 0;
const listeners = new Set<() => void>();

function read(): Record<string, string> {
  if (cache) return cache;
  const parsed: Record<string, string> = {};
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [id, title] of Object.entries(raw)) {
        if (typeof title === "string" && title.trim()) parsed[id] = title.trim().slice(0, MAX_TITLE);
      }
    }
  } catch {
    // A broken entry drops the custom titles; chats fall back to their first message.
  }
  cache = parsed;
  return parsed;
}

/** The title the person gave this chat, if any. */
export function customChatTitle(chatId: string | undefined): string | undefined {
  if (!chatId || typeof window === "undefined") return undefined;
  return read()[chatId];
}

/** Gives the chat a title, or with an empty one goes back to the title from its first message. */
export function setChatTitle(chatId: string, title: string): void {
  const next = { ...read() };
  const clean = title.trim().slice(0, MAX_TITLE);
  if (clean) next[chatId] = clean;
  else delete next[chatId];
  const ids = Object.keys(next);
  cache =
    ids.length > MAX_REMEMBERED
      ? Object.fromEntries(ids.slice(-MAX_REMEMBERED).map((id) => [id, next[id] ?? ""]))
      : next;
  version += 1;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Storage can be unavailable; the title still holds until the window closes.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Changes whenever a chat is renamed, so lists that show titles draw again. */
export function useChatTitlesVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
}
