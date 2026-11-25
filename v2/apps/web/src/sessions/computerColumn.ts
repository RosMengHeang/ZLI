import { useSyncExternalStore } from "react";

const HIDDEN_KEY = "zli.computerColumn.hidden";
/** Below this tile width the column would squeeze the chat, so it opens over the chat instead, on request. */
export const COMPUTER_OVERLAY_WIDTH = 680;

const listeners = new Set<() => void>();
let hidden = readHidden();

function readHidden(): boolean {
  try {
    return window.localStorage.getItem(HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Whether the chat's computer column shows beside wide chats. It shows by default, and closing it in one chat
 * closes it in every chat, remembered per browser profile. Storage can be missing or blocked, so it never throws.
 */
export function useComputerColumnShown(): boolean {
  return !useSyncExternalStore(subscribe, () => hidden);
}

export function setComputerColumnShown(shown: boolean): void {
  if (hidden === !shown) return;
  hidden = !shown;
  try {
    if (hidden) window.localStorage.setItem(HIDDEN_KEY, "1");
    else window.localStorage.removeItem(HIDDEN_KEY);
  } catch {
    // The choice still holds for this window; it just is not remembered.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tests start from the default. */
export function resetComputerColumnForTests(): void {
  hidden = readHidden();
  for (const listener of listeners) listener();
}
