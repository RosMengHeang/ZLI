import type { TerminalSession } from "../types";
import { providerDisplayName } from "../types/models.ts";
import { providerLaunchFailureMessage } from "./providerDiagnostics.ts";

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

function startExclusive(id: string, operation: () => Promise<void>): { task: Promise<void>; started: boolean } {
  const existing = pending.get(id);
  if (existing) return { task: existing, started: false };
  const task = Promise.resolve().then(operation).finally(() => {
    pending.delete(id);
    notify();
  });
  pending.set(id, task);
  notify();
  return { task, started: true };
}

export const terminalRetry = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  isRetrying: (id: string) => pending.has(id),
  async runExclusive(id: string, operation: () => Promise<void>): Promise<boolean> {
    const { task, started } = startExclusive(id, operation);
    if (!started) return false;
    await task;
    return true;
  },
  run<T extends TerminalSession>(id: string, operations: RetryOperations<T>): Promise<void> {
    return startExclusive(id, async () => {
      try {
        if (!operations.isCurrent()) return;
        await operations.closeOriginal();
        if (!operations.isCurrent()) return;
        const replacement = await operations.create();
        if (replacement.status !== "running" && replacement.status !== "starting") {
          await operations.dispose(replacement);
          throw new Error(replacement.error || (replacement.provider
            ? providerLaunchFailureMessage({
                providerName: providerDisplayName(replacement.provider),
                cwd: replacement.cwd,
                exitCode: replacement.exitCode,
              })
            : "Replacement terminal failed to start."));
        }
        if (!operations.swap(replacement)) {
          await operations.dispose(replacement);
          return;
        }
        await operations.releaseOriginal();
      } catch (error) {
        if (operations.isCurrent()) operations.fail(error);
      }
    }).task;
  },
};
