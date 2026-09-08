import type { TerminalSession } from "../types";

interface RetryOperations<T extends TerminalSession> {
  isCurrent: () => boolean;
  closeOriginal: () => Promise<void>;
  create: () => Promise<T>;
  swap: (replacement: T) => boolean;
  dispose: (replacement: T) => Promise<void>;
  releaseOriginal: () => Promise<void>;
  fail: (error: unknown) => void;
}

// Terminal ownership outlives any particular pane component or subscription.
const pending = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

export const terminalRetry = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  isRetrying: (id: string) => pending.has(id),
  run<T extends TerminalSession>(id: string, operations: RetryOperations<T>): Promise<void> {
    const existing = pending.get(id);
    if (existing) return existing;
    const task = Promise.resolve().then(async () => {
      try {
        if (!operations.isCurrent()) return;
        await operations.closeOriginal();
        if (!operations.isCurrent()) return;
        const replacement = await operations.create();
        if (replacement.status !== "running" && replacement.status !== "starting") {
          await operations.dispose(replacement);
          throw new Error(replacement.error || "Replacement terminal failed to start.");
        }
        if (!operations.swap(replacement)) {
          await operations.dispose(replacement);
          return;
        }
        await operations.releaseOriginal();
      } catch (error) {
        if (operations.isCurrent()) operations.fail(error);
      } finally {
        pending.delete(id);
        notify();
      }
    });
    pending.set(id, task);
    notify();
    return task;
  },
};
