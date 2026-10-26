import type { Account, PlanLimitReading, PlanLimitWindow, ProviderDiscovery } from "@zli-v2/contracts";
import { USUAL_LOGIN_ACCOUNT_ID } from "@zli-v2/contracts";
import { useId } from "react";

import { accountLabel, USUAL_LOGIN_LABEL } from "../accounts/accounts.js";
import { providerDisplayName } from "../agent/providers.js";
import {
  formatPercent,
  LIMIT_WARN_PERCENT,
  limitKey,
  resetText,
  showsReading,
  visibleWindows,
  windowLabel,
  windowName,
} from "../limits/limits.js";
import { ProviderMark } from "../ui/ProviderMark.js";

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
  /** For tests; the person's own time zone otherwise. */
  timeZone?: string;
  onOpen(): void;
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
 * How much of each login's plan limits is used, above Settings: one circle per limit the provider
 * reports, each with its reset. The numbers come from Anthropic and OpenAI; the card opens Usage.
 */
export function SidebarUsageStrip({ readings, providers, accounts, now, currentKey, timeZone, onOpen }: Props) {
  const descriptionId = useId();
  const shown = readings?.filter(showsReading) ?? [];
  if (shown.length === 0) return null;

  const withAccounts = new Set(
    shown.filter((reading) => reading.accountId !== USUAL_LOGIN_ACCOUNT_ID).map((reading) => reading.provider),
  );
  const all: Row[] = shown.map((reading) => {
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
      windows: visibleWindows(reading),
      current: key === currentKey,
    };
  });
  const rows = all.slice(0, MAX_ROWS);
  const current = all.find((row) => row.current);
  if (current && !rows.includes(current)) rows[rows.length - 1] = current;
  const more = all.length - rows.length;
  const description = [
    ...rows.map(
      (row) => `${[row.name, row.account].filter(Boolean).join(", ")}: ${rowDescription(row, now, timeZone)}`,
    ),
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
      <span className="usage-strip-head" aria-hidden="true">
        Limits used
      </span>
      {rows.map((row) => (
        <LoginRow key={row.key} row={row} now={now} timeZone={timeZone} />
      ))}
      {more > 0 ? (
        <span className="usage-strip-more" aria-hidden="true">
          +{more} more
        </span>
      ) : null}
    </button>
  );
}

function LoginRow({ row, now, timeZone }: { row: Row; now: number; timeZone: string | undefined }) {
  const { reading } = row;
  const stale = reading.state !== "ok";
  return (
    <span
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
    </span>
  );
}

function WindowLine({ window, now, timeZone }: { window: PlanLimitWindow; now: number; timeZone: string | undefined }) {
  const reset = resetText(window, now, timeZone);
  const used = Math.min(100, Math.max(0, window.usedPercent));
  const tone = reset.passed ? " is-passed" : used >= 100 ? " is-full" : used >= LIMIT_WARN_PERCENT ? " is-warning" : "";
  return (
    <span className={`usage-strip-window${tone}`}>
      <LimitRing percent={reset.passed ? 0 : used} />
      <span className="usage-strip-window-label">{windowLabel(window)}</span>
      <span className="usage-strip-window-percent">{reset.passed ? "–" : formatPercent(used)}</span>
      <span className="usage-strip-window-reset">{reset.text}</span>
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

function windowKey(window: PlanLimitWindow): string {
  return `${window.kind ?? "usage"}:${window.scope ?? ""}:${window.durationMinutes ?? ""}`;
}

function rowDescription(row: Row, now: number, timeZone: string | undefined): string {
  const parts = row.windows.map((window) => {
    const reset = resetText(window, now, timeZone);
    if (reset.passed) return `the ${windowName(window)} limit just reset`;
    return `${formatPercent(window.usedPercent)} of the ${windowName(window)} limit used, ${reset.text.replace(" · ", " at ")}`;
  });
  const state = row.reading.state === "ok" ? "" : (row.reading.message ?? stateText[row.reading.state]);
  return `${[parts.join("; "), state].filter(Boolean).join(". ")}${row.current ? ", selected agent" : ""}.`;
}
