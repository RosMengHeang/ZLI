import { useSyncExternalStore } from "react";

/**
 * Which shells were started in the right panel's terminal. The drawer at the bottom lists every other shell, so the
 * two never show the same one. Kept across reloads; ids of shells that are gone are harmless.
 */
const KEY = "zli.panelTerminals.v1";
const listeners = new Set<() => void>();
let ids: ReadonlySet<string> = load();

function load(): ReadonlySet<string> {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export function markPanelTerminal(terminalId: string): void {
  if (ids.has(terminalId)) return;
  ids = new Set([...ids, terminalId].slice(-50));
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify([...ids]));
  } catch {
    // Storage can be off; the split still holds until the app reloads.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePanelTerminals(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribe,
    () => ids,
    () => ids,
  );
}
