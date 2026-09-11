export type PendingTerminalLifecycle =
  | { status: "exited"; exitCode: number | null }
  | { status: "error"; message: string };

interface StoredLifecycle {
  value: PendingTerminalLifecycle;
  createdAt: number;
}

export interface PendingTerminalLifecycleStore {
  remember: (terminalId: string, lifecycle: PendingTerminalLifecycle) => void;
  take: (terminalId: string) => PendingTerminalLifecycle | null;
  clear: (terminalId: string) => void;
  size: () => number;
}

const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_TTL_MS = 30_000;

export function createPendingTerminalLifecycle(
  now: () => number = Date.now,
  options: { maxEntries?: number; ttlMs?: number } = {},
): PendingTerminalLifecycleStore {
  const maxEntries = Math.max(1, Math.trunc(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
  const ttlMs = Math.max(1, Math.trunc(options.ttlMs ?? DEFAULT_TTL_MS));
  const pending = new Map<string, StoredLifecycle>();

  function prune(): void {
    const current = now();
    for (const [terminalId, entry] of pending) {
      if (current - entry.createdAt > ttlMs) pending.delete(terminalId);
    }
  }

  return {
    remember: (terminalId, lifecycle) => {
      if (!terminalId.trim()) return;
      prune();
      pending.delete(terminalId);
      pending.set(terminalId, { value: lifecycle, createdAt: now() });
      while (pending.size > maxEntries) {
        const oldest = pending.keys().next().value;
        if (typeof oldest !== "string") break;
        pending.delete(oldest);
      }
    },
    take: (terminalId) => {
      prune();
      const entry = pending.get(terminalId);
      if (!entry) return null;
      pending.delete(terminalId);
      return entry.value;
    },
    clear: (terminalId) => {
      pending.delete(terminalId);
    },
    size: () => {
      prune();
      return pending.size;
    },
  };
}
