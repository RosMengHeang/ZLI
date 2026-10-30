import type { Account, PlanLimitReading, PlanLimitWindow, ProviderDiscovery } from "@zli-v2/contracts";
import { USUAL_LOGIN_ACCOUNT_ID } from "@zli-v2/contracts";
import { type ReactNode, useId, useState } from "react";

import { accountLabel, USUAL_LOGIN_LABEL } from "../accounts/accounts.js";
import { providerDisplayName } from "../agent/providers.js";
import {
  formatPercent,
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
  /** For tests; the person's own time zone otherwise. */
  timeZone?: string;
  /** Opens Settings at Usage, where the card and its agents are chosen. */
  onOpenSettings(): void;
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
export function SidebarPlanLimits(props: Omit<Props, "readings" | "hidden">) {
  const { sidebarLimits } = useAppSettings();
  if (!sidebarLimits.enabled) return (props.children ?? stacked)({});
  return <LiveUsageStrip {...props} hidden={sidebarLimits.hidden} />;
}

function LiveUsageStrip(props: Omit<Props, "readings">) {
  const limits = usePlanLimits(props.accounts?.map((account) => account.id).join(","));
  return <SidebarUsageStrip {...props} readings={limits.status === "loading" ? undefined : limits.readings} />;
}

/**
 * How much of each login's plan limits is used. The line is the selected agent's login at its
 * fullest limit, or the fullest limit of any login when no agent with limits is selected, so it never
 * crowds the project list. Clicking it unfolds every login with a circle per limit and its reset.
 */
export function SidebarUsageStrip({
  readings,
  providers,
  accounts,
  now,
  currentKey,
  hidden,
  timeZone,
  onOpenSettings,
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
  const summary = summaryOf(rows, now);
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
        data-tooltip={open ? undefined : summaryTooltip(summary)}
        onClick={toggle}
      >
        <span id={descriptionId} className="sr-only">
          {description}
        </span>
        <Summary summary={summary} />
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
        <button type="button" className="usage-strip-settings" onClick={onOpenSettings}>
          Choose agents
        </button>
      </div>
    ) : undefined,
  });
}

type SummaryPick = { row: Row; window: PlanLimitWindow | undefined };

/**
 * The folded line: one login's fullest limit, or why it has none. Where the footer is narrow, the
 * agent's mark stands in for its name and the window label goes, so the share always fits.
 */
function Summary({ summary: { row, window } }: { summary: SummaryPick }) {
  const used = window ? Math.min(100, Math.max(0, window.usedPercent)) : 0;
  return (
    <span
      className={`usage-strip-summary${row.reading.state === "ok" ? "" : " is-stale"}${window ? tone(used) : ""}`}
      aria-hidden="true"
    >
      <LimitRing percent={used} />
      <ProviderMark provider={row.reading.provider} size={12} />
      <span className="usage-strip-provider">{row.name}</span>
      {row.account ? <span className="usage-strip-account">{row.account}</span> : null}
      {window ? (
        <span className="usage-strip-summary-limit">
          <span className="usage-strip-window-label">{windowLabel(window)}</span>
          <span className="usage-strip-window-percent">{formatPercent(used)}</span>
        </span>
      ) : row.reading.state === "ok" ? null : (
        <span className="usage-strip-state">{stateText[row.reading.state]}</span>
      )}
    </span>
  );
}

/**
 * The selected agent's login when it has numbers, otherwise the login closest to its limit. Within a
 * login, the fullest window whose reset has not passed, since that is the one that stops the agent.
 */
function summaryOf(rows: readonly Row[], now: number): SummaryPick {
  const fullest = (row: Row) =>
    row.windows
      .filter((window) => !resetText(window, now).passed)
      .reduce<PlanLimitWindow | undefined>(
        (best, window) => (!best || window.usedPercent > best.usedPercent ? window : best),
        undefined,
      );
  const current = rows.find((row) => row.current && fullest(row));
  if (current) return { row: current, window: fullest(current) };
  let best: SummaryPick | undefined;
  for (const row of rows) {
    const window = fullest(row);
    if (window && (!best?.window || window.usedPercent > best.window.usedPercent)) best = { row, window };
  }
  return best ?? { row: rows[0] as Row, window: undefined };
}

/** The folded line in words, for when its name and label do not fit: "Codex, 5-hour limit: 34% used". */
function summaryTooltip({ row, window }: SummaryPick): string {
  const who = [row.name, row.account].filter(Boolean).join(", ");
  if (!window) return row.reading.state === "ok" ? who : `${who}: ${stateText[row.reading.state]}`;
  const limit = [windowName(window), "limit"].filter(Boolean).join(" ");
  return `${who}, ${limit}: ${formatPercent(window.usedPercent)} used`;
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

function WindowLine({ window, now, timeZone }: { window: PlanLimitWindow; now: number; timeZone: string | undefined }) {
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
      <span className="usage-strip-window-reset" data-tooltip={reset.clock ? `Resets ${reset.clock}` : undefined}>
        {reset.text}
      </span>
    </span>
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
