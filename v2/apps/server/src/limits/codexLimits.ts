import { FIVE_HOUR_WINDOW, MONTHLY_WINDOW, type PlanLimitWindow, WEEKLY_WINDOW } from "@zli-v2/contracts";

import { clamp, number, record, text } from "./answerFields.js";
import type { LimitRead } from "./PlanLimits.js";

export type CodexLimitClient = { readRateLimits(): Promise<unknown>; close(): Promise<void> };

const READ_TIMEOUT_MS = 20_000;

/**
 * Asks a short-lived Codex app server for the signed-in plan's windows, so limits show for every
 * account even when no chat runs. Codex reads its own login; ZLI never opens auth.json.
 */
export async function readCodexLimits(connect: () => Promise<CodexLimitClient>): Promise<LimitRead> {
  let client: CodexLimitClient | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    const raw = await Promise.race([
      (async () => {
        client = await connect();
        return client.readRateLimits();
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Codex took too long to answer.")), READ_TIMEOUT_MS);
      }),
    ]);
    return codexLimitRead(raw);
  } catch (error) {
    return codexFailure(error);
  } finally {
    clearTimeout(timer);
    await client?.close().catch(() => undefined);
  }
}

/** Accepts the current camelCase answer and the snake_case one Codex 0.48 to 0.55 sent. */
export function codexLimitRead(raw: unknown): LimitRead {
  const answer = record(raw);
  const byId = record(answer?.rateLimitsByLimitId);
  const snapshot = record(byId?.codex) ?? record(answer?.rateLimits) ?? record(answer?.rate_limits);
  const plan = text(snapshot?.planType) ?? text(snapshot?.plan_type);
  // Slots say nothing about length: a weekly-only plan sends its week as `primary`. Only a window
  // without a length falls back to its slot, and free and Go plans count by the month.
  const primaryLength = plan === "free" || plan === "go" ? MONTHLY_WINDOW : FIVE_HOUR_WINDOW;
  const windows = [codexWindow(snapshot?.primary, primaryLength), codexWindow(snapshot?.secondary, WEEKLY_WINDOW)]
    .filter((window): window is PlanLimitWindow => window !== undefined)
    .sort((left, right) => (left.durationMinutes ?? 0) - (right.durationMinutes ?? 0));
  if (windows.length === 0) {
    return {
      state: "unavailable",
      message: "This Codex login has no plan limits. API keys are billed by use instead.",
      windows: [],
      ...(plan ? { plan } : {}),
    };
  }
  return { state: "ok", windows, ...(plan ? { plan } : {}) };
}

function codexWindow(value: unknown, fallbackMinutes: number): PlanLimitWindow | undefined {
  const window = record(value);
  if (!window) return undefined;
  const used = number(window.usedPercent) ?? number(window.used_percent);
  if (used === undefined) return undefined;
  const minutes = number(window.windowDurationMins) ?? number(window.window_minutes);
  const resetsAt = number(window.resetsAt) ?? number(window.resets_at);
  return {
    usedPercent: clamp(used),
    durationMinutes: minutes && minutes > 0 ? Math.round(minutes) : fallbackMinutes,
    // Codex sends Unix seconds.
    ...(resetsAt && resetsAt > 0 ? { resetsAt: new Date(resetsAt * 1000).toISOString() } : {}),
  };
}

function codexFailure(error: unknown): LimitRead {
  const message = error instanceof Error ? error.message : String(error);
  if (/not (logged|signed) in|login|unauthori[sz]ed|auth/iu.test(message)) {
    return { state: "signed-out", message: "Not signed in to Codex.", windows: [] };
  }
  if (/not found|ENOENT|was not found/iu.test(message)) {
    return { state: "unavailable", message: "Codex is not installed.", windows: [] };
  }
  return { state: "error", message: "Codex did not report its limits. ZLI will try again.", windows: [] };
}
