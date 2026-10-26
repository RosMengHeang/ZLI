import type { PlanLimitProvider, PlanLimitReading, PlanLimitsResult, PlanLimitWindow } from "@zli-v2/contracts";
import { FIVE_HOUR_WINDOW, USUAL_LOGIN_ACCOUNT_ID, WEEKLY_WINDOW } from "@zli-v2/contracts";

/** What one reader learned. `retryAfterMs` asks the cache to wait longer than usual before the next try. */
export type LimitRead = {
  state: PlanLimitReading["state"];
  windows: PlanLimitWindow[];
  message?: string;
  plan?: string;
  retryAfterMs?: number;
};

/** One login to read: the usual one, or a saved sign-in account and the folder that holds its login. */
export type LimitTarget = { provider: PlanLimitProvider; accountId: string; configDir?: string };

export type LimitReader = (target: LimitTarget) => Promise<LimitRead>;

/** How long a reading is reused without asking the provider again. */
export const LIMITS_FRESH_MS = 5 * 60_000;
/** A manual refresh still waits this long after the last read, so clicks cannot flood the provider. */
export const LIMITS_MIN_REFRESH_MS = 60_000;

type Cached = { reading: PlanLimitReading; readAt: number; nextAt: number; backoffUntil: number };

/**
 * Plan limits for every login ZLI knows, read in the background whether or not an agent runs. Readings
 * are cached per login; a failed read keeps the last windows and says why they may be old.
 */
export class PlanLimits {
  private readonly cache = new Map<string, Cached>();
  private readonly pending = new Map<string, Promise<PlanLimitReading>>();

  constructor(
    private readonly options: {
      targets(): Promise<LimitTarget[]>;
      read: LimitReader;
      now?: () => number;
    },
  ) {}

  async read(refresh = false): Promise<PlanLimitsResult> {
    const targets = await this.options.targets();
    const keys = new Set(targets.map(targetKey));
    for (const key of this.cache.keys()) if (!keys.has(key)) this.cache.delete(key);
    return { readings: await Promise.all(targets.map((target) => this.readOne(target, refresh))) };
  }

  private readOne(target: LimitTarget, refresh: boolean): Promise<PlanLimitReading> {
    const key = targetKey(target);
    const running = this.pending.get(key);
    if (running) return running;
    const now = this.now();
    const cached = this.cache.get(key);
    const due =
      !cached ||
      now >= cached.nextAt ||
      (refresh && now - cached.readAt >= LIMITS_MIN_REFRESH_MS && now >= cached.backoffUntil);
    if (cached && !due) return Promise.resolve(cached.reading);
    const work = this.fetch(target, cached?.reading).finally(() => this.pending.delete(key));
    this.pending.set(key, work);
    return work;
  }

  private async fetch(target: LimitTarget, previous: PlanLimitReading | undefined): Promise<PlanLimitReading> {
    let read: LimitRead;
    try {
      read = await this.options.read(target);
    } catch {
      read = { state: "error", message: "The limits could not be read. ZLI will try again.", windows: [] };
    }
    const now = this.now();
    const plan = read.plan ?? previous?.plan;
    const base = { provider: target.provider, accountId: target.accountId, ...(plan ? { plan } : {}) };
    const reading: PlanLimitReading =
      read.state === "ok"
        ? { ...base, state: "ok", windows: read.windows, checkedAt: new Date(now).toISOString() }
        : {
            ...base,
            state: read.state,
            ...(read.message ? { message: read.message } : {}),
            windows: previous?.windows ?? [],
            ...(previous?.checkedAt ? { checkedAt: previous.checkedAt } : {}),
          };
    this.cache.set(targetKey(target), {
      reading,
      readAt: now,
      nextAt: now + (read.retryAfterMs ?? LIMITS_FRESH_MS),
      backoffUntil: read.retryAfterMs ? now + read.retryAfterMs : 0,
    });
    return reading;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function targetKey(target: LimitTarget): string {
  return `${target.provider}:${target.accountId}`;
}

/**
 * Fixed readings for the Electron integration harness, which runs no real agent CLI. Each login gets
 * the same numbers on every run, with reset times counted from now.
 */
export function mockLimitRead(target: LimitTarget, now = Date.now()): LimitRead {
  const window = (durationMinutes: number, usedPercent: number, resetMinutes: number): PlanLimitWindow => ({
    durationMinutes,
    usedPercent,
    resetsAt: new Date(now + resetMinutes * 60_000).toISOString(),
  });
  if (target.accountId !== USUAL_LOGIN_ACCOUNT_ID) {
    return {
      state: "ok",
      plan: "pro",
      windows: [window(FIVE_HOUR_WINDOW, 8, 255), window(WEEKLY_WINDOW, 63, 2 * 1_440)],
    };
  }
  return target.provider === "claude-code"
    ? { state: "ok", plan: "max", windows: [window(FIVE_HOUR_WINDOW, 86, 47), window(WEEKLY_WINDOW, 41, 3 * 1_440)] }
    : { state: "ok", plan: "plus", windows: [window(FIVE_HOUR_WINDOW, 34, 130), window(WEEKLY_WINDOW, 12, 4 * 1_440)] };
}
