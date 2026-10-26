import type { Account, PlanLimitReading, PlanLimitWindow, ProviderDiscovery } from "@zli-v2/contracts";
import { USUAL_LOGIN_ACCOUNT_ID } from "@zli-v2/contracts";
import { useId } from "react";

import { accountLabel, USUAL_LOGIN_LABEL } from "../accounts/accounts.js";
import { providerDisplayName } from "../agent/providers.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import { formatPercent, formatResetIn, LIMIT_WARN_PERCENT, limitKey, limitWindows } from "../limits/limits.js";

const MAX_ROWS = 3;
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
  /** The limit key of the selected agent's login, to mark its row and keep it in view. */
  currentKey?: string | undefined;
  onOpen(): void;
};

type Row = {
  key: string;
  reading: PlanLimitReading;
  name: string;
  account: string | undefined;
  fiveHour?: PlanLimitWindow;
  week?: PlanLimitWindow;
  current: boolean;
};

/**
 * How much of each login's 5-hour and weekly plan limit is used, above Settings. The numbers come from
 * Anthropic and OpenAI; the whole card opens the Usage dialog.
 */
export function SidebarUsageStrip({ readings, providers, accounts, now, currentKey, onOpen }: Props) {
  const descriptionId = useId();
  if (!readings || readings.length === 0) return null;

  const withAccounts = new Set(
    readings.filter((reading) => reading.accountId !== USUAL_LOGIN_ACCOUNT_ID).map((reading) => reading.provider),
  );
  const all: Row[] = readings.map((reading) => {
    const key = limitKey(reading.provider, reading.accountId);
    return {
      key,
      reading,
      name: providerDisplayName(reading.provider, providers),
      account:
        reading.accountId === USUAL_LOGIN_ACCOUNT_ID
          ? withAccounts.has(reading.provider)
            ? USUAL_LOGIN_LABEL
            : undefined
          : accountLabel(accounts, reading.accountId),
      ...limitWindows(reading),
      current: key === currentKey,
    };
  });
  const rows = all.slice(0, MAX_ROWS);
  const current = all.find((row) => row.current);
  if (current && !rows.includes(current)) rows[rows.length - 1] = current;
  const more = all.length - rows.length;
  const description = [
    ...rows.map((row) => `${[row.name, row.account].filter(Boolean).join(", ")}: ${rowDescription(row, now)}`),
    more > 0 ? `${more} more.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      className="sidebar-usage-strip"
      aria-label="Plan limits"
      aria-describedby={descriptionId}
      data-tooltip={TOOLTIP}
      onClick={onOpen}
    >
      <span id={descriptionId} className="sr-only">
        {description}
      </span>
      <span className="usage-strip-grid" aria-hidden="true">
        <span className="usage-strip-head">Limits used</span>
        <span className="usage-strip-head usage-strip-number">5h</span>
        <span className="usage-strip-head usage-strip-number">Week</span>
        {rows.map((row) => (
          <StripRow key={row.key} row={row} now={now} />
        ))}
      </span>
      {more > 0 ? (
        <span className="usage-strip-more" aria-hidden="true">
          +{more} more
        </span>
      ) : null}
    </button>
  );
}

function StripRow({ row, now }: { row: Row; now: number }) {
  const { reading } = row;
  const stale = reading.state !== "ok";
  const hasWindows = row.fiveHour !== undefined || row.week !== undefined;
  const nearly = [row.fiveHour, row.week].find((window) => window && window.usedPercent >= LIMIT_WARN_PERCENT);
  const resetIn = nearly ? formatResetIn(nearly.resetsAt, now) : undefined;
  return (
    <span
      className={`usage-strip-row${row.current ? " is-current" : ""}${stale ? " is-stale" : ""}`}
      title={reading.message}
    >
      <span className="usage-strip-name">
        <ProviderMark provider={reading.provider} size={12} />
        <span className="usage-strip-provider">{row.name}</span>
        {row.account ? <span className="usage-strip-account">{row.account}</span> : null}
      </span>
      {hasWindows ? (
        <>
          <WindowCell window={row.fiveHour} />
          <WindowCell window={row.week} />
        </>
      ) : (
        <span className="usage-strip-state">{reading.state === "ok" ? "No limits" : stateText[reading.state]}</span>
      )}
      {resetIn ? (
        <span className="usage-strip-reset">
          {nearly === row.fiveHour ? "5h" : "Week"} resets in {resetIn}
        </span>
      ) : null}
    </span>
  );
}

function WindowCell({ window }: { window: PlanLimitWindow | undefined }) {
  if (!window) return <span className="usage-strip-number usage-strip-window is-missing">-</span>;
  const used = Math.min(100, Math.max(0, window.usedPercent));
  return (
    <span className={`usage-strip-number usage-strip-window${used >= LIMIT_WARN_PERCENT ? " is-warning" : ""}`}>
      {formatPercent(used)}
      <span className="usage-strip-bar">
        <span style={{ width: `${used}%` }} />
      </span>
    </span>
  );
}

function rowDescription(row: Row, now: number): string {
  const parts = [windowDescription(row.fiveHour, "5-hour", now), windowDescription(row.week, "weekly", now)].filter(
    Boolean,
  );
  const state = row.reading.state === "ok" ? "" : (row.reading.message ?? stateText[row.reading.state]);
  return `${[parts.join(", "), state].filter(Boolean).join(". ")}${row.current ? ", selected agent" : ""}.`;
}

function windowDescription(window: PlanLimitWindow | undefined, name: string, now: number): string {
  if (!window) return "";
  const resetIn = formatResetIn(window.resetsAt, now);
  return `${formatPercent(window.usedPercent)} of the ${name} limit used${resetIn ? `, resets in ${resetIn}` : ""}`;
}
