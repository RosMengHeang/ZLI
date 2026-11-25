import type { ListedProviderKind, ProviderUpdateInfo } from "@zli-v2/contracts";
import { useEffect, useSyncExternalStore } from "react";

import { checkProviderUpdates, type Dispatch, updateProvider } from "../welcome/welcomeClient.js";

export type AgentUpdateNote = {
  tone: "ok" | "error";
  text: string;
  output?: string | undefined;
  /** The version it moved to, for a successful update. */
  version?: string | undefined;
  at: number;
};

export type AgentUpdatesState = {
  /** Undefined until the first check answers. */
  updates: readonly ProviderUpdateInfo[] | undefined;
  checking: boolean;
  checkedAt: number | undefined;
  error: string | undefined;
  running: ReadonlySet<ListedProviderKind>;
  notes: Partial<Record<ListedProviderKind, AgentUpdateNote>>;
};

/** How often the sidebar asks again while ZLI stays open, the same rhythm as the app's own update check. */
export const AGENT_CHECK_EVERY_MS = 4 * 60 * 60_000;

const initial: AgentUpdatesState = {
  updates: undefined,
  checking: false,
  checkedAt: undefined,
  error: undefined,
  running: new Set(),
  notes: {},
};
let state = initial;
const listeners = new Set<() => void>();

function set(change: (current: AgentUpdatesState) => AgentUpdatesState): void {
  state = change(state);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** One list for Settings and the sidebar, so an update started in one shows in the other. */
export function useAgentUpdates(): AgentUpdatesState {
  return useSyncExternalStore(subscribe, () => state);
}

/** Agents with a newer version that ZLI can install itself. */
export function pendingAgentUpdates(current: AgentUpdatesState): ProviderUpdateInfo[] {
  return current.updates?.filter((entry) => entry.status === "behind" && entry.canUpdate) ?? [];
}

export async function checkAgentUpdates(dispatch: Dispatch): Promise<void> {
  if (state.checking) return;
  set((current) => ({ ...current, checking: true }));
  const result = await checkProviderUpdates(dispatch);
  set((current) =>
    result.ok
      ? { ...current, checking: false, checkedAt: Date.now(), updates: result.value, error: undefined }
      : { ...current, checking: false, error: result.error },
  );
}

export async function runAgentUpdate(dispatch: Dispatch, provider: ListedProviderKind): Promise<void> {
  if (state.running.has(provider)) return;
  set((current) => {
    const { [provider]: _old, ...notes } = current.notes;
    return { ...current, running: new Set(current.running).add(provider), notes };
  });
  const result = await updateProvider(dispatch, provider);
  set((current) => {
    const running = new Set(current.running);
    running.delete(provider);
    if (!result.ok) {
      return {
        ...current,
        running,
        notes: { ...current.notes, [provider]: { tone: "error", text: result.error, at: Date.now() } },
      };
    }
    const { outcome, message, output, updates } = result.value;
    const version = updates.find((entry) => entry.provider === provider)?.current;
    return {
      ...current,
      running,
      updates,
      checkedAt: Date.now(),
      notes: {
        ...current.notes,
        [provider]: { tone: outcome === "failed" ? "error" : "ok", text: message, output, version, at: Date.now() },
      },
    };
  });
}

export function runAllAgentUpdates(dispatch: Dispatch): void {
  for (const entry of pendingAgentUpdates(state)) void runAgentUpdate(dispatch, entry.provider);
}

/** Checks once when ZLI opens and again every few hours while it stays open. */
export function useAgentUpdateChecks(dispatch: Dispatch, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const due = () => state.checkedAt === undefined || Date.now() - state.checkedAt >= AGENT_CHECK_EVERY_MS;
    if (due()) void checkAgentUpdates(dispatch);
    const timer = setInterval(() => {
      if (due()) void checkAgentUpdates(dispatch);
    }, 15 * 60_000);
    return () => clearInterval(timer);
  }, [dispatch, enabled]);
}

/** For tests. */
export function resetAgentUpdates(): void {
  state = initial;
  for (const listener of listeners) listener();
}
