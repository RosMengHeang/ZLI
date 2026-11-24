import type { Account, PlanLimitReading, PlanLimitWindow, ProviderDiscovery } from "@zli-v2/contracts";
import { FIVE_HOUR_WINDOW, USUAL_LOGIN_ACCOUNT_ID, WEEKLY_WINDOW } from "@zli-v2/contracts";
import { type ReactNode, useId, useState } from "react";

import { accountLabel, USUAL_LOGIN_LABEL } from "../accounts/accounts.js";
import { providerDisplayName } from "../agent/providers.js";
import {
  formatPercent,
  formatResetIn,
  LIMIT_WARN_PERCENT,
  limitKey,
  resetText,
  showsReading,
  usePlanLimits,
  visibleWindows,
  windowLabel,
  windowName,
} from "../limits/limits.js";
import { useAppSettings } from "../settings/appSettings.js";
import { Icon } from "../ui/Icon.js";
import { ProviderMark } from "../ui/ProviderMark.js";

const OPEN_KEY = "zli.sidebar.limitsOpen";

const stateText: Record<Exclude<PlanLimitReading["state"], "ok">, string> = {
  "signed-out": "Signed out",
  expired: "Sign in again",
  unavailable: "No plan limits",
  error: "Could not check",
};

type Props = {
  /** Undefined while the first reading loads. */
  readings: readonly PlanLimitReading[] | undefined;
  providers: readonly ProviderDiscovery[] | undefined;
  /** Undefined until the saved accounts have loaded. */
  accounts: readonly Account[] | undefined;
  now: number;
  /** The limit key of the selected agent's login, to mark its row and sum it up while folded. */
  currentKey?: string | undefined;
  /** Agents switched off in Settings. */
  hidden?: readonly string[] | undefined;
  /** The agent the folded line always shows, chosen in Settings. */
  pinned?: string | undefined;
  /** For tests; the person's own time zone otherwise. */
  timeZone?: string;
  /** Opens Settings at Providers, where the card and its agents are chosen. */
  onOpenSettings(): void;
  /** Opens the usage and cost report. */
  onOpenUsage?: (() => void) | undefined;
  /**
   * Places the two parts: the folded line, which fits in a row of its own, and the list it unfolds.
   * Both are missing while there is nothing to show. Without it, the list sits above the line.
   */
  children?: ((slots: LimitSlots) => ReactNode) | undefined;
};

export type LimitSlots = { line?: ReactNode; panel?: ReactNode };

const stacked = ({ line, panel }: LimitSlots) => (
  <>
    {panel}
    {line}
  </>
);

type Row = {
  key: string;
  reading: PlanLimitReading;
  name: string;
  account: string | undefined;
  windows: PlanLimitWindow[];
  current: boolean;
};

/**
 * The card, when it is turned on in Settings. Limits are read only while it is on, so ZLI never asks
 * a provider about a plan the person did not ask to see.
 */
export function SidebarPlanLimits(props: Omit<Props, "readings" | "hidden" | "pinned">) {
  const { sidebarLimits } = useAppSettings();
  if (!sidebarLimits.enabled) return (props.children ?? stacked)({});
  return <LiveUsageStrip {...props} hidden={sidebarLimits.hidden} pinned={sidebarLimits.pinned} />;
}

function LiveUsageStrip(props: Omit<Props, "readings">) {
  const limits = usePlanLimits(props.accounts?.map((account) => account.id).join(","));
  return <SidebarUsageStrip {...props} readings={limits.status === "loading" ? undefined : limits.readings} />;
}

/**
 * How much of each login's plan limits is used. The line is the pinned agent's login at its 5-hour
 * limit; without a pin, the selected agent's, or the fullest limit of any login when no agent with
 * limits is selected, so it never crowds the project list. Clicking it unfolds every login with a
 * circle per limit and its reset.
 */
export function SidebarUsageStrip({
  readings,
  providers,
  accounts,
  now,
  currentKey,
  hidden,
  pinned,
  timeZone,
  onOpenSettings,
  onOpenUsage,
  children = stacked,
}: Props) {
  const descriptionId = useId();
  const listId = useId();
  const [open, setOpen] = useState(readOpen);
  const shown = readings?.filter((reading) => showsReading(reading) && !hidden?.includes(reading.provider)) ?? [];
  if (shown.length === 0) return children({});

  const withAccounts = new Set(
    shown.filter((reading) => reading.accountId !== USUAL_LOGIN_ACCOUNT_ID).map((reading) => reading.provider),
  );
  const rows: Row[] = shown.map((reading) => {
    const key = limitKey(reading.provider, reading.accountId);
    return {
      key,
      reading,
      name: providerDisplayName(reading.provider, providers),
      // "Usual login" only tells two logins of one agent apart; alone, the agent's name is enough.
      account:
        reading.accountId === USUAL_LOGIN_ACCOUNT_ID
          ? withAccounts.has(reading.provider)
            ? USUAL_LOGIN_LABEL
            : undefined
          : accountLabel(accounts, reading.accountId),
      windows: visibleWindows(reading),
      current: key === currentKey,
    };
  });
  const description = rows
    .map((row) => `${[row.name, row.account].filter(Boolean).join(", ")}: ${rowDescription(row, now, timeZone)}`)
    .join(" ");
  const summary = summaryOf(rows, now, pinned);
  const toggle = () =>
    setOpen((current) => {
      writeOpen(!current);
      return !current;
    });

  return children({
    line: (
      <button
        type="button"
        className="usage-strip-toggle"
        aria-label="Plan limits"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-describedby={descriptionId}
        data-tooltip={open ? undefined : summaryTooltip(summary, now)}
        onClick={toggle}
      >
        <span id={descriptionId} className="sr-only">
          {description}
        </span>
        <Summary summary={summary} now={now} />
        <Icon name="chevronUp" size={12} className="usage-strip-chevron" aria-hidden="true" />
      </button>
    ),
    panel: open ? (
      <div id={listId} className="sidebar-usage-strip">
        <span className="usage-strip-head" aria-hidden="true">
          Plan limits
        </span>
        <div className="usage-strip-list">
          {rows.map((row) => (
            <LoginRow key={row.key} row={row} now={now} timeZone={timeZone} />
          ))}
        </div>
        <div className="usage-strip-links">
          {onOpenUsage ? (
            <button type="button" className="usage-strip-settings" onClick={onOpenUsage}>
              Usage and cost
            </button>
          ) : null}
          <button type="button" className="usage-strip-settings" onClick={onOpenSettings}>
            Choose agents
          </button>
        </div>
      </div>
    ) : undefined,
  });
}

type SummaryPick = {
  row: Row;
  window: PlanLimitWindow | undefined;
  /** The weekly window beside the 5-hour one, for a pinned or selected agent that has both. */
  weekly?: PlanLimitWindow | undefined;
};

/**
 * The folded line: the agent's mark, one limit's circle and share, and the time until it resets. No
 * words, so it fits the narrowest sidebar; the tooltip and the description name the limit.
 */
function Summary({ summary: { row, window, weekly }, now }: { summary: SummaryPick; now: number }) {
  const used = window ? Math.min(100, Math.max(0, window.usedPercent)) : 0;
  return (
    <span
      className={`usage-strip-summary${row.reading.state === "ok" ? "" : " is-stale"}${window && !weekly ? tone(used) : ""}${weekly ? " is-dual" : ""}`}
      aria-hidden="true"
    >
      <ProviderMark provider={row.reading.provider} size={13} />
      {window ? (
        <>
          <SummaryWindow window={window} now={now} label={weekly ? "5h" : undefined} />
          {weekly ? <SummaryWindow window={weekly} now={now} label="wk" /> : null}
          {/* Only the Project rail style shows this. Elsewhere the line is too tight for it. */}
          <span className="usage-strip-bar">
            <span style={{ width: `${used}%` }} />
          </span>
        </>
      ) : row.reading.state === "ok" ? null : (
        <Icon name="alert" size={12} className="usage-strip-state" />
      )}
    </span>
  );
}

/** One limit on the folded line: "5h ◔ 40% · 3h". The label shows only when two limits share the line. */
function SummaryWindow({ window, now, label }: { window: PlanLimitWindow; now: number; label: string | undefined }) {
  const used = Math.min(100, Math.max(0, window.usedPercent));
  const resetIn = formatResetIn(window.resetsAt, now);
  const short = resetIn?.split(" ")[0] ?? resetIn;
  return (
    <span className={`usage-strip-summary-window${tone(used)}`}>
      {label ? <span className="usage-strip-summary-label">{label}</span> : null}
      <LimitRing percent={used} />
      <span className="usage-strip-window-percent">{formatPercent(used)}</span>
      {resetIn && short ? (
        <span className="usage-strip-summary-reset">
          {/* A narrow sidebar gets the largest unit, "2h"; a wide one says it in full. Two limits keep it short. */}
          <ResetTime long={label ? short : `Resets in ${resetIn}`} short={short} />
        </span>
      ) : null}
    </span>
  );
}

/**
 * The pinned agent's logins when it has any on the card, otherwise every login. Among them, the
 * selected agent's login when it has numbers, otherwise the one closest to its limit.
 *
 * Within a login, the fullest window whose reset has not passed, since that is the one that stops the
 * agent. A pinned or selected agent shows its 5-hour window instead when it has one: that is the
 * number people watch while they work, and the weekly one moves too slowly to tell them much.
 */
function summaryOf(rows: readonly Row[], now: number, pinned: string | undefined): SummaryPick {
  const own = pinned ? rows.filter((row) => row.reading.provider === pinned) : [];
  const pool = own.length > 0 ? own : rows;
  const live = (row: Row) => row.windows.filter((window) => !resetText(window, now).passed);
  const fullest = (row: Row) =>
    live(row).reduce<PlanLimitWindow | undefined>(
      (best, window) => (!best || window.usedPercent > best.usedPercent ? window : best),
      undefined,
    );
  const fiveHourOrFullest = (row: Row) => {
    const fiveHour = live(row).filter(
      (window) => window.kind !== "spend" && window.durationMinutes === FIVE_HOUR_WINDOW,
    );
    return fiveHour.find((window) => !window.scope) ?? fiveHour[0] ?? fullest(row);
  };
  // Beside a 5-hour window, the plan's own weekly one, so a pinned agent shows both at a glance.
  const withWeekly = (row: Row): SummaryPick => {
    const window = fiveHourOrFullest(row);
    const weekly =
      window?.durationMinutes === FIVE_HOUR_WINDOW
        ? live(row).find((entry) => entry.kind !== "spend" && !entry.scope && entry.durationMinutes === WEEKLY_WINDOW)
        : undefined;
    return { row, window, ...(weekly ? { weekly } : {}) };
  };
  const current = pool.find((row) => row.current && fullest(row));
  if (current) return withWeekly(current);
  const pick = own.length > 0 ? fiveHourOrFullest : fullest;
  let best: SummaryPick | undefined;
  for (const row of pool) {
    const window = pick(row);
    if (window && (!best?.window || window.usedPercent > best.window.usedPercent)) best = { row, window };
  }
  if (best && own.length > 0) return withWeekly(best.row);
  return best ?? { row: pool[0] as Row, window: undefined };
}

/** The folded line in words, since it shows none: "Codex, 5-hour limit: 34% used, resets in 47m". */
function summaryTooltip({ row, window, weekly }: SummaryPick, now: number): string {
  const who = [row.name, row.account].filter(Boolean).join(", ");
  if (!window) return row.reading.state === "ok" ? who : `${who}: ${stateText[row.reading.state]}`;
  const say = (entry: PlanLimitWindow) => {
    const limit = [windowName(entry), "limit"].filter(Boolean).join(" ");
    const resetIn = formatResetIn(entry.resetsAt, now);
    return `${limit}: ${formatPercent(entry.usedPercent)} used${resetIn ? `, resets in ${resetIn}` : ""}`;
  };
  return `${who}, ${[window, ...(weekly ? [weekly] : [])].map(say).join("; ")}`;
}

function LoginRow({ row, now, timeZone }: { row: Row; now: number; timeZone: string | undefined }) {
  const { reading } = row;
  const stale = reading.state !== "ok";
  return (
    <div
      className={`usage-strip-row${row.current ? " is-current" : ""}${stale ? " is-stale" : ""}`}
      title={reading.message}
      aria-hidden="true"
    >
      <span className="usage-strip-name">
        <ProviderMark provider={reading.provider} size={12} />
        <span className="usage-strip-provider">{row.name}</span>
        {row.account ? <span className="usage-strip-account">{row.account}</span> : null}
        {reading.state === "ok" ? null : <span className="usage-strip-state">{stateText[reading.state]}</span>}
      </span>
      {row.windows.length > 0 ? (
        <span className="usage-strip-windows">
          {row.windows.map((window) => (
            <WindowLine key={windowKey(window)} window={window} now={now} timeZone={timeZone} />
          ))}
        </span>
      ) : null}
    </div>
  );
}

/** One limit: its circle, name, share used, and when it resets. Settings → Providers shows these too. */
export function WindowLine({
  window,
  now,
  timeZone,
}: {
  window: PlanLimitWindow;
  now: number;
  timeZone: string | undefined;
}) {
  const reset = resetText(window, now, timeZone);
  const used = Math.min(100, Math.max(0, window.usedPercent));
  return (
    <span className={`usage-strip-window${reset.passed ? " is-passed" : tone(used)}`}>
      <LimitRing percent={reset.passed ? 0 : used} />
      <span
        className="usage-strip-window-label"
        data-tooltip={sentence([windowName(window), "limit"].filter(Boolean).join(" "))}
      >
        {windowLabel(window)}
      </span>
      <span className="usage-strip-window-percent">{reset.passed ? "–" : formatPercent(used)}</span>
      {/* In full when the card has room; just the countdown, "2h 10m", when it is narrow. */}
      <span
        className="usage-strip-window-reset"
        data-tooltip={reset.clock ? `${reset.text}, at ${reset.clock}` : undefined}
      >
        <ResetTime
          long={reset.text}
          short={reset.clock ? (formatResetIn(window.resetsAt, now) ?? reset.text) : reset.text}
        />
      </span>
    </span>
  );
}

/** Both wordings are rendered; the container's width picks which one shows, so nothing measures in script. */
function ResetTime({ long, short }: { long: string; short: string }) {
  if (long === short) return <>{long}</>;
  return (
    <>
      <span className="reset-long">{long}</span>
      <span className="reset-short">{short}</span>
    </>
  );
}

const RING_RADIUS = 5.5;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

function LimitRing({ percent }: { percent: number }) {
  return (
    <svg className="usage-strip-ring" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle className="usage-strip-ring-track" cx="8" cy="8" r={RING_RADIUS} />
      <circle
        className="usage-strip-ring-fill"
        cx="8"
        cy="8"
        r={RING_RADIUS}
        strokeDasharray={`${(percent / 100) * RING_LENGTH} ${RING_LENGTH}`}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}

function tone(used: number): string {
  return used >= 100 ? " is-full" : used >= LIMIT_WARN_PERCENT ? " is-warning" : "";
}

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function windowKey(window: PlanLimitWindow): string {
  return `${window.kind ?? "usage"}:${window.scope ?? ""}:${window.durationMinutes ?? ""}`;
}

function rowDescription(row: Row, now: number, timeZone: string | undefined): string {
  const parts = row.windows.map((window) => {
    const reset = resetText(window, now, timeZone);
    if (reset.passed) return `the ${windowName(window)} limit just reset`;
    const when = `${reset.text.toLowerCase()}${reset.clock ? ` at ${reset.clock}` : ""}`;
    return `${formatPercent(window.usedPercent)} of the ${windowName(window)} limit used, ${when}`;
  });
  const state = row.reading.state === "ok" ? "" : (row.reading.message ?? stateText[row.reading.state]);
  return `${[parts.join("; "), state].filter(Boolean).join(". ")}${row.current ? ", selected agent" : ""}.`;
}

function readOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeOpen(open: boolean): void {
  try {
    if (open) window.localStorage.setItem(OPEN_KEY, "1");
    else window.localStorage.removeItem(OPEN_KEY);
  } catch {
    // Storage can be full or blocked; the card still folds for this window.
  }
}
