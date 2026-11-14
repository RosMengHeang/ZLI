import { randomUUID } from "node:crypto";

import { CommandId, type RuntimeEventEnvelope, ThreadId, type ThreadProjection } from "@zli-v2/contracts";

import type { Engine } from "../orchestration/Engine.js";

export const RESUME_TEXT = "Continue where you left off.";
/** Claude reports the reset to the second; a short wait keeps the first request from landing just before it. */
const RESET_GRACE_MS = 30_000;
/** Long timers drift across sleep, so a far-off reset is checked again on the way. */
const MAX_WAIT_MS = 5 * 60_000;
/** How soon a resume the runtime refused is tried again. */
const RETRY_MS = 60_000;

type Options = { now?: () => number };

/**
 * Sends "Continue where you left off." to each chat that the person set to resume once its usage limit
 * resets. The message resumes the agent's own conversation, the same as one the person typed.
 */
export class UsageLimitResumer {
  private readonly unsubscribe: () => void;
  private readonly now: () => number;
  private readonly sent = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(
    private readonly engine: Engine,
    options: Options = {},
  ) {
    this.now = options.now ?? Date.now;
    this.unsubscribe = engine.subscribe((envelope) => this.observe(envelope));
    void this.check();
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe();
    if (this.timer) clearTimeout(this.timer);
  }

  /** Resumes every chat whose reset has passed and waits for the next one. Exposed for tests. */
  async check(): Promise<void> {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const projection = await this.engine.projection();
    const now = this.now();
    let next = Number.POSITIVE_INFINITY;
    for (const thread of projection.threads) {
      const dueAt = resumeDueAt(thread);
      if (dueAt === undefined) {
        this.sent.delete(thread.threadId);
        continue;
      }
      if (dueAt > now) {
        next = Math.min(next, dueAt);
        continue;
      }
      if (this.sent.has(thread.threadId)) continue;
      // Marked before sending, so a check running at the same time leaves it alone, and unmarked when the
      // runtime refuses, so the attempt is made again later.
      this.sent.add(thread.threadId);
      const waiting = (projection.queuedMessages ?? []).some((queued) => queued.threadId === thread.threadId);
      if (!(await this.resume(thread.threadId, waiting))) {
        this.sent.delete(thread.threadId);
        next = Math.min(next, now + RETRY_MS);
      }
    }
    if (this.stopped || !Number.isFinite(next)) return;
    this.timer = setTimeout(() => void this.check(), Math.min(Math.max(next - now, 1_000), MAX_WAIT_MS));
    this.timer.unref?.();
  }

  private observe(envelope: RuntimeEventEnvelope): void {
    const type = envelope.event.type;
    if (type === "thread.status.changed" || type === "thread.limit.resume.changed") void this.check();
  }

  /**
   * True when the runtime accepted it. A chat with messages already waiting is only woken, so those go out
   * and no queue slot is needed; otherwise it is told to continue.
   */
  private async resume(threadId: string, waiting: boolean): Promise<boolean> {
    try {
      const receipt = await this.engine.dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(randomUUID()),
        command: waiting
          ? { type: "thread.wake", threadId: ThreadId.parse(threadId) }
          : { type: "thread.queue", queueId: randomUUID(), threadId: ThreadId.parse(threadId), text: RESUME_TEXT },
      });
      return receipt.status === "accepted";
    } catch {
      // The chat may have been removed or can no longer resume; the person can still send by hand.
      return false;
    }
  }
}

function resumeDueAt(thread: ThreadProjection): number | undefined {
  const limit = thread.usageLimit;
  if (!limit?.autoResume || !limit.resetsAt || !thread.providerSessionId) return undefined;
  if (thread.status !== "failed" && thread.status !== "stopped") return undefined;
  const resetMs = Date.parse(limit.resetsAt);
  return Number.isFinite(resetMs) ? resetMs + RESET_GRACE_MS : undefined;
}
