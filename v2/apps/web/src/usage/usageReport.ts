import { type RpcResponse, type UsageDay, type UsageRange, UsageReport, type UsageTokens } from "@zli-v2/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";

type Dispatch = (request: unknown) => Promise<RpcResponse | undefined>;

export const USAGE_RANGE_OPTIONS: readonly { value: UsageRange; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "all", label: "All" },
];

export function localTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

export async function readUsageReport(dispatch: Dispatch, range: UsageRange): Promise<UsageReport> {
  const timeZone = localTimeZone();
  const response = await dispatch({
    protocolVersion: 1,
    commandId: makeCommandId(),
    command: { type: "usage.read", range, ...(timeZone ? { timeZone } : {}) },
  });
  if (!response) throw new Error("ZLI is not connected to its runtime.");
  if (!response.accepted) throw new Error(response.error.message);
  const parsed = UsageReport.safeParse(response.result);
  if (!parsed.success) throw new Error("The runtime sent an unexpected reply.");
  return parsed.data;
}

export type UsageReportState =
  | { status: "loading"; report?: UsageReport | undefined }
  | { status: "ready"; report: UsageReport }
  | { status: "error"; message: string; report?: UsageReport | undefined };

/** The report for a range, read when the range changes and on `reload`. The last report stays shown while the next loads. */
export function useUsageReport(range: UsageRange): { state: UsageReportState; reload: () => void } {
  const { dispatch } = useRuntime();
  const [state, setState] = useState<UsageReportState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt only triggers a fresh read.
  useEffect(() => {
    const id = ++latest.current;
    setState((current) => ({ status: "loading", report: current.report }));
    readUsageReport(dispatch, range).then(
      (report) => {
        if (id === latest.current) setState({ status: "ready", report });
      },
      (error: unknown) => {
        if (id !== latest.current) return;
        const message = error instanceof Error ? error.message : String(error);
        setState((current) => ({ status: "error", message, report: current.report }));
      },
    );
  }, [dispatch, range, attempt]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  return { state, reload };
}

/** Every billed token: input, output, and cache reads and writes. Reasoning is already in output. */
export function totalTokens(tokens: UsageTokens): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

/** Dollars at a precision that suits the amount: "$3,442", "$443.73", "$0.13", "under $0.01". */
export function formatUsd(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return "under $0.01";
  if (usd >= 1_000) return `$${Math.round(usd).toLocaleString("en-US")}`;
  return `$${usd.toFixed(2)}`;
}

export type ChartBar = {
  key: string;
  /** "Nov 21", or "Nov 15 – Nov 21" for a week. */
  label: string;
  tokens: number;
  costUsd: number;
  providers: UsageDay["providers"];
};

/** Past this many days the chart shows weeks, so each bar stays wide enough to point at. */
export const WEEKLY_AFTER_DAYS = 92;

/** The chart's bars: one per day, or one per 7 days ending on the last day for long ranges. */
export function chartBars(days: readonly UsageDay[]): ChartBar[] {
  if (days.length <= WEEKLY_AFTER_DAYS) {
    return days.map((day) => ({ key: day.date, label: shortDate(day.date), ...pick(day) }));
  }
  const bars: ChartBar[] = [];
  for (let end = days.length; end > 0; end -= 7) {
    const week = days.slice(Math.max(0, end - 7), end);
    const first = week[0];
    const last = week.at(-1);
    if (!first || !last) continue;
    const providers = new Map<string, { tokens: number; costUsd: number }>();
    for (const day of week) {
      for (const slice of day.providers) {
        const held = providers.get(slice.provider) ?? { tokens: 0, costUsd: 0 };
        held.tokens += slice.tokens;
        held.costUsd += slice.costUsd;
        providers.set(slice.provider, held);
      }
    }
    bars.unshift({
      key: first.date,
      label: `${shortDate(first.date)} – ${shortDate(last.date)}`,
      tokens: week.reduce((sum, day) => sum + day.tokens, 0),
      costUsd: week.reduce((sum, day) => sum + day.costUsd, 0),
      providers: [...providers].map(([provider, slice]) => ({
        provider: provider as UsageDay["providers"][number]["provider"],
        ...slice,
      })),
    });
  }
  return bars;
}

function pick(day: UsageDay) {
  return { tokens: day.tokens, costUsd: day.costUsd, providers: day.providers };
}

/** "Nov 21" for a YYYY-MM-DD day, read as a calendar day so no time zone moves it. */
export function shortDate(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(
    Date.UTC(year ?? 1970, (month ?? 1) - 1, date ?? 1),
  );
}
