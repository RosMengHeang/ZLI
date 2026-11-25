import type { Engine } from "../orchestration/Engine.js";

/** How often the setting is checked. Trimming itself only deletes what crossed the cutoff since last time. */
const CHECK_EVERY_MS = 6 * 60 * 60_000;
/** The first check waits until startup is done, so it never slows opening the app. */
const FIRST_CHECK_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/**
 * Event types that stay in the log whatever their age: after a restart, the terminal and worktree reactors
 * read them back to restore a running terminal or a worktree still being set up.
 */
export const KEPT_EVENT_TYPES = ["terminal.create.requested", "worktree.create.requested"] as const;

/**
 * Trims the change log when the person chose a shorter history in Settings. With the default (keep
 * everything) it never deletes anything.
 */
export class HistoryRetention {
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly engine: Pick<Engine, "trimHistory">,
    private readonly retentionDays: () => number | undefined,
    private readonly log: (message: string, detail: Record<string, unknown>) => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.schedule(FIRST_CHECK_MS);
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** Trims now if a shorter history is set. Returns what was deleted, or undefined when keeping everything. */
  async runOnce(): Promise<{ events: number; receipts: number } | undefined> {
    const days = this.retentionDays();
    if (days === undefined || days <= 0) return undefined;
    const removed = await this.engine.trimHistory(new Date(this.now() - days * DAY_MS), KEPT_EVENT_TYPES);
    if (removed.events + removed.receipts > 0) this.log("history trimmed", { days, ...removed });
    return removed;
  }

  private schedule(delay: number): void {
    this.#timer = setTimeout(() => {
      void this.runOnce()
        .catch((error: unknown) =>
          this.log("history trim failed", { error: error instanceof Error ? error.message : String(error) }),
        )
        .finally(() => this.schedule(CHECK_EVERY_MS));
    }, delay);
    this.#timer.unref?.();
  }
}
