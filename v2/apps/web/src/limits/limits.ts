import {
  DAILY_WINDOW,
  FIVE_HOUR_WINDOW,
  MONTHLY_WINDOW,
  PLAN_LIMIT_PROVIDERS,
  type PlanLimitProvider,
  type PlanLimitReading,
  PlanLimitsResult,
  type PlanLimitWindow,
  type RpcResponse,
  USUAL_LOGIN_ACCOUNT_ID,
  WEEKLY_WINDOW,
} from "@zli-v2/contracts";
import { useEffect, useSyncExternalStore } from "react";

import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";

type Dispatch = (request: unknown) => Promise<RpcResponse | undefined>;

/** The runtime caches readings for 5 minutes, so polling faster would only repeat them. */
export const LIMITS_POLL_MS = 5 * 60_000;
/** Used at or above this share, a window shows as nearly spent. */
export const LIMIT_WARN_PERCENT = 80;
/** Most windows a row shows; the tightest model limits come after the whole-plan ones. */
const MAX_WINDOWS = 3;

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
 * Whether a login belongs on the card. A login with no plan limits (an API key, say) never does. The
 * usual login shows only once its windows were read: a CLI that is installed but signed out, turned
 * down, or unreachable is not a plan the person uses. A saved account was set up in ZLI, so it always
 * says why it has no numbers.
 */
export function showsReading(reading: PlanLimitReading): boolean {
  if (reading.state === "unavailable") return false;
  if (reading.accountId === USUAL_LOGIN_ACCOUNT_ID) return reading.windows.length > 0;
  return reading.state !== "ok" || reading.windows.length > 0;
}

/** The agents with at least one login on the card, in a fixed order so a list of them stays put. */
export function limitProviders(readings: readonly PlanLimitReading[]): PlanLimitProvider[] {
  const shown = new Set<string>(readings.filter(showsReading).map((reading) => reading.provider));
  return PLAN_LIMIT_PROVIDERS.filter((provider) => shown.has(provider));
}

/**
 * The windows a row shows, shortest first. Every whole-plan window the provider reports shows, and
 * only those: a weekly-only plan gets one circle, not an empty 5-hour one. A model limit shows when
 * it is the one that will stop the agent, or always when the plan is limited only per model, as
 * Gemini is. A paid monthly cap shows only when the plan has no windows.
 */
export function visibleWindows(reading: Pick<PlanLimitReading, "windows">): PlanLimitWindow[] {
  const plan = reading.windows
    .filter((window) => window.kind !== "spend" && !window.scope)
    .sort((left, right) => (left.durationMinutes ?? 0) - (right.durationMinutes ?? 0));
  const weekly = Math.max(
    0,
    ...plan.filter((window) => (window.durationMinutes ?? 0) >= WEEKLY_WINDOW).map((window) => window.usedPercent),
  );
  const scoped = reading.windows
    .filter(
      (window) =>
        window.kind !== "spend" &&
        window.scope &&
        (plan.length === 0 || window.usedPercent >= LIMIT_WARN_PERCENT || window.usedPercent > weekly),
    )
    .sort((left, right) => right.usedPercent - left.usedPercent);
  const spend = plan.length === 0 ? reading.windows.filter((window) => window.kind === "spend") : [];
  return [...plan, ...scoped, ...spend].slice(0, MAX_WINDOWS);
}

/** A short name for a circle: "5h", "Day", "Week", "Month", a model name, or "Extra" for a paid cap. */
export function windowLabel(window: PlanLimitWindow): string {
  if (window.kind === "spend") return "Extra";
  return window.scope ?? lengthLabel(window.durationMinutes);
}

function lengthLabel(minutes: number | undefined): string {
  if (minutes === undefined) return "Limit";
  if (minutes === DAILY_WINDOW) return "Day";
  if (minutes === WEEKLY_WINDOW) return "Week";
  if (Math.abs(minutes - MONTHLY_WINDOW) <= 3 * DAILY_WINDOW) return "Month";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < DAILY_WINDOW) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / DAILY_WINDOW)}d`;
}

/** The spoken name of a window, as in "5-hour" or "Fable weekly", for "the … limit". */
export function windowName(window: PlanLimitWindow): string {
  if (window.kind === "spend") return "extra usage";
  const label = lengthLabel(window.durationMinutes);
  const length = { "5h": "5-hour", Day: "daily", Week: "weekly", Month: "monthly", Limit: "" }[label] ?? label;
  return [window.scope, length].filter(Boolean).join(" ");
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

/**
 * The local time of a reset: "3:40 PM" within a day, "Tue 9:00 AM" this week, "Nov 3" later. It is
 * always read with the countdown, which already says whether a time within a day is today or tomorrow.
 */
export function formatResetClock(resetsAt: string, now: number, timeZone?: string): string | undefined {
  const at = Date.parse(resetsAt);
  if (Number.isNaN(at)) return undefined;
  const zone = timeZone ? { timeZone } : {};
  const day = (value: number) => new Intl.DateTimeFormat("en-CA", { ...zone, dateStyle: "short" }).format(value);
  // Always with minutes, "9:00 AM" and never "9 AM", so every reset reads the same way.
  const time = new Intl.DateTimeFormat(undefined, { ...zone, hour: "numeric", minute: "2-digit" }).format(at);
  if (day(at) === day(now) || at - now < 86_400_000) return time;
  if (at - now < 6 * 86_400_000) {
    return `${new Intl.DateTimeFormat(undefined, { ...zone, weekday: "short" }).format(at)} ${time}`;
  }
  return new Intl.DateTimeFormat(undefined, { ...zone, month: "short", day: "numeric" }).format(at);
}

/**
 * What a circle says about its reset, always: "Resets in 2h 10m" when the provider gave a time, with
 * the local time kept aside as `clock`, otherwise why there is none. A window whose reset has passed
 * shows no share until the next read.
 */
export function resetText(
  window: PlanLimitWindow,
  now: number,
  timeZone?: string,
): { text: string; passed: boolean; clock?: string } {
  if (window.resetsAt && Date.parse(window.resetsAt) <= now) return { text: "Reset, checking", passed: true };
  const countdown = formatResetIn(window.resetsAt, now);
  const clock = window.resetsAt ? formatResetClock(window.resetsAt, now, timeZone) : undefined;
  if (countdown && clock) return { text: `Resets in ${countdown}`, passed: false, clock };
  if (window.kind === "spend") return { text: "Resets monthly", passed: false };
  // Claude leaves the 5-hour reset empty until the first message opens the window.
  if (window.usedPercent === 0) return { text: "Starts when used", passed: false };
  return { text: "Reset time unknown", passed: false };
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
