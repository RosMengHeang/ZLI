import {
  type PlanLimitReading,
  PlanLimitsResult,
  type PlanLimitWindow,
  type RpcResponse,
  USUAL_LOGIN_ACCOUNT_ID,
} from "@zli-v2/contracts";
import { useEffect, useSyncExternalStore } from "react";

import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";

type Dispatch = (request: unknown) => Promise<RpcResponse | undefined>;

/** The runtime caches readings for 5 minutes, so polling faster would only repeat them. */
export const LIMITS_POLL_MS = 5 * 60_000;
/** Used at or above this share, a window shows as nearly spent. */
export const LIMIT_WARN_PERCENT = 80;
/** Windows up to a day long count as the short window; longer ones as the weekly one. */
const SHORT_WINDOW_MAX_MINUTES = 1_440;

export async function readPlanLimits(dispatch: Dispatch, refresh = false): Promise<PlanLimitReading[]> {
  const response = await dispatch({
    protocolVersion: 1,
    commandId: makeCommandId(),
    command: { type: "limits.read", ...(refresh ? { refresh: true } : {}) },
  });
  if (!response) throw new Error("ZLI is not connected to its runtime.");
  if (!response.accepted) {
    if (response.error.code === "unavailable") return [];
    throw new Error(response.error.message);
  }
  const parsed = PlanLimitsResult.safeParse(response.result);
  if (!parsed.success) throw new Error("The runtime sent an unexpected reply.");
  return parsed.data.readings;
}

/** The key that matches a reading to the agent using that login. */
export function limitKey(provider: string, accountId: string | undefined): string {
  return `${provider}:${accountId ?? USUAL_LOGIN_ACCOUNT_ID}`;
}

/**
 * The 5-hour and weekly windows of a reading. Windows are sorted by length, so one without a length
 * falls back to its place: first is the short window, second the weekly one.
 */
export function limitWindows(reading: Pick<PlanLimitReading, "windows">): {
  fiveHour?: PlanLimitWindow;
  week?: PlanLimitWindow;
} {
  const result: { fiveHour?: PlanLimitWindow; week?: PlanLimitWindow } = {};
  reading.windows.forEach((window, index) => {
    const short =
      window.durationMinutes === undefined ? index === 0 : window.durationMinutes <= SHORT_WINDOW_MAX_MINUTES;
    if (short) result.fiveHour ??= window;
    else result.week ??= window;
  });
  return result;
}

export function formatPercent(value: number): string {
  // 99.6% used is not 100%: rounding up would claim the window is spent while it still has room.
  return `${value >= 100 ? 100 : Math.min(99, Math.round(value))}%`;
}

/** "47m", "3h 12m", or "2d 4h" until the reset. Undefined without a reset time, so none is ever made up. */
export function formatResetIn(resetsAt: string | undefined, now: number): string | undefined {
  if (!resetsAt) return undefined;
  const at = Date.parse(resetsAt);
  if (Number.isNaN(at)) return undefined;
  const minutes = Math.max(0, Math.ceil((at - now) / 60_000));
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

export type PlanLimitsState =
  | { status: "loading" }
  | { status: "ready"; readings: readonly PlanLimitReading[] }
  | { status: "error"; message: string; readings: readonly PlanLimitReading[] };

let shared: PlanLimitsState = { status: "loading" };
const listeners = new Set<() => void>();

function publish(next: PlanLimitsState): void {
  shared = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function load(dispatch: Dispatch): Promise<void> {
  try {
    publish({ status: "ready", readings: await readPlanLimits(dispatch) });
  } catch (error) {
    const readings = shared.status === "loading" ? [] : shared.readings;
    publish({ status: "error", message: error instanceof Error ? error.message : String(error), readings });
  }
}

/** Forgets the shared readings, for tests that start a new runtime. */
export function resetPlanLimitsStore(): void {
  publish({ status: "loading" });
}

/**
 * Plan limits for every login, read when the window opens, every few minutes, when ZLI comes back to
 * the front, and when `reloadKey` changes (for example after an account is added).
 */
export function usePlanLimits(reloadKey?: string): PlanLimitsState {
  const { dispatch } = useRuntime();
  const state = useSyncExternalStore(subscribe, () => shared);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey only triggers a fresh read.
  useEffect(() => {
    void load(dispatch);
    const timer = setInterval(() => void load(dispatch), LIMITS_POLL_MS);
    const onFocus = () => void load(dispatch);
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [dispatch, reloadKey]);

  return state;
}
