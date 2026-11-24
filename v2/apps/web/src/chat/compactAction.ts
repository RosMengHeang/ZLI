import { createContext, useContext, useSyncExternalStore } from "react";

/**
 * What the context meter offers for the chat around it. The chat provides it, so the meter can offer
 * "Compact now" without the message box passing it along.
 */
export type CompactAction = {
  status: "ready" | "compacting" | "unavailable";
  run(): void;
  /** Why compacting is unavailable, or how this agent compacts. */
  note?: string;
  /** Automatic compacting starts at this share of the window, when it is on. */
  autoAt?: number;
};

export const CompactActionContext = createContext<CompactAction | undefined>(undefined);

export function useCompactAction(): CompactAction | undefined {
  return useContext(CompactActionContext);
}

// Each open chat also publishes its action by thread, so the right panel's overview can offer "Compact now"
// for the chat in view without sitting inside it.
let published: ReadonlyMap<string, CompactAction> = new Map();
const listeners = new Set<() => void>();

export function publishCompactAction(threadId: string, action: CompactAction | undefined): void {
  if (published.get(threadId) === action) return;
  const next = new Map(published);
  if (action) next.set(threadId, action);
  else next.delete(threadId);
  published = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The compact action of an open chat, by its thread. Undefined while that chat is not open or has ended. */
export function useCompactActionFor(threadId: string | undefined): CompactAction | undefined {
  return useSyncExternalStore(subscribe, () => (threadId ? published.get(threadId) : undefined));
}
