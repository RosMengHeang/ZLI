import { FIVE_HOUR_WINDOW, type PlanLimitWindow } from "@zli-v2/contracts";

import type { LimitRead } from "./PlanLimits.js";

type Client = { readRateLimits(): Promise<unknown>; close(): Promise<void> };

const READ_TIMEOUT_MS = 20_000;

/**
 * Asks a short-lived Codex app server for the signed-in plan's windows, so limits show for every
 * account even when no chat runs. Codex reads its own login; ZLI never opens auth.json.
 */
export async function readCodexLimits(connect: () => Promise<Client>): Promise<LimitRead> {
  let client: Client | undefined;
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
  const windows = [snapshot?.primary, snapshot?.secondary]
    .map(codexWindow)
    .filter((window): window is PlanLimitWindow => window !== undefined)
    .sort((left, right) => (left.durationMinutes ?? FIVE_HOUR_WINDOW) - (right.durationMinutes ?? FIVE_HOUR_WINDOW));
  const plan = text(snapshot?.planType) ?? text(snapshot?.plan_type);
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

function codexWindow(value: unknown): PlanLimitWindow | undefined {
  const window = record(value);
  if (!window) return undefined;
  const used = number(window.usedPercent) ?? number(window.used_percent);
  if (used === undefined) return undefined;
  const minutes = number(window.windowDurationMins) ?? number(window.window_minutes);
  const resetsAt = number(window.resetsAt) ?? number(window.resets_at);
  return {
    usedPercent: Math.min(100, Math.max(0, used)),
    ...(minutes && minutes > 0 ? { durationMinutes: Math.round(minutes) } : {}),
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

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 60) : undefined;
}
