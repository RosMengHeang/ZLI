import type { Account, PlanLimitReading, PlanLimitWindow, ProviderDiscovery } from "@zli-v2/contracts";
import { USUAL_LOGIN_ACCOUNT_ID } from "@zli-v2/contracts";
import { useId, useState } from "react";

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
const TOOLTIP = "Plan limits used. Tokens and cost are under Usage.";

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
};

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
  if (!sidebarLimits.enabled) return null;
  return <LiveUsageStrip {...props} hidden={sidebarLimits.hidden} />;
}

function LiveUsageStrip(props: Omit<Props, "readings">) {
  const limits = usePlanLimits(props.accounts?.map((account) => account.id).join(","));
  return <SidebarUsageStrip {...props} readings={limits.status === "loading" ? undefined : limits.readings} />;
}

/**
 * How much of each login's plan limits is used, above Settings. Folded, it is one line for the
 * selected agent's login, or the fullest limit when no agent with limits is selected, so it never
 * crowds the project list. Unfolded, it lists every login with a circle per limit and its reset.
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
}: Props) {
  const descriptionId = useId();
  const listId = useId();
  const [open, setOpen] = useState(readOpen);
  const shown = readings?.filter((reading) => showsReading(reading) && !hidden?.includes(reading.provider)) ?? [];
  if (shown.length === 0) return null;

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
  const toggle = () =>
    setOpen((current) => {
      writeOpen(!current);
      return !current;
    });

  return (
    <div className={`sidebar-usage-strip${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="usage-strip-toggle"
        aria-label="Plan limits"
        aria-expanded={open}
        aria-controls={listId}
        aria-describedby={descriptionId}
        data-tooltip={TOOLTIP}
        onClick={toggle}
      >
        <span id={descriptionId} className="sr-only">
          {description}
        </span>
        {open ? (
          <span className="usage-strip-head" aria-hidden="true">
            Plan limits
          </span>
        ) : (
          <Summary rows={rows} now={now} />
        )}
        <Icon name="chevronUp" size={12} className="usage-strip-chevron" aria-hidden="true" />
      </button>
      {open ? (
        <div id={listId} className="usage-strip-list">
          {rows.map((row) => (
            <LoginRow key={row.key} row={row} now={now} timeZone={timeZone} />
          ))}
          <button type="button" className="usage-strip-settings" onClick={onOpenSettings}>
            Choose agents
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The folded line: one login's fullest limit, or why it has none. */
function Summary({ rows, now }: { rows: readonly Row[]; now: number }) {
  const { row, window } = summaryOf(rows, now);
  const used = window ? Math.min(100, Math.max(0, window.usedPercent)) : 0;
  return (
    <span
      className={`usage-strip-summary${row.reading.state === "ok" ? "" : " is-stale"}${window ? tone(used) : ""}`}
      aria-hidden="true"
    >
      <LimitRing percent={used} />
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
function summaryOf(rows: readonly Row[], now: number): { row: Row; window: PlanLimitWindow | undefined } {
  const fullest = (row: Row) =>
    row.windows
      .filter((window) => !resetText(window, now).passed)
      .reduce<PlanLimitWindow | undefined>(
        (best, window) => (!best || window.usedPercent > best.usedPercent ? window : best),
        undefined,
      );
  const current = rows.find((row) => row.current && fullest(row));
  if (current) return { row: current, window: fullest(current) };
  let best: { row: Row; window: PlanLimitWindow | undefined } | undefined;
  for (const row of rows) {
    const window = fullest(row);
    if (window && (!best?.window || window.usedPercent > best.window.usedPercent)) best = { row, window };
  }
  return best ?? { row: rows[0] as Row, window: undefined };
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
