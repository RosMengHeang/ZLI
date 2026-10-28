import type { Account, PlanLimitReading, PlanLimitWindow, ProviderDiscovery } from "@zli-v2/contracts";
import { USUAL_LOGIN_ACCOUNT_ID } from "@zli-v2/contracts";
import { useId } from "react";

import { accountLabel, USUAL_LOGIN_LABEL } from "../accounts/accounts.js";
import { providerDisplayName } from "../agent/providers.js";
import { LimitRing } from "../limits/LimitRing.js";
import {
  formatPercent,
  LIMIT_STATE_TEXT,
  limitKey,
  resetText,
  showsReading,
  usePlanLimits,
  visibleWindows,
  windowDisplay,
  windowLabel,
  windowName,
} from "../limits/limits.js";
import { useAppSettings } from "../settings/appSettings.js";
import { ProviderMark } from "../ui/ProviderMark.js";

const MAX_ROWS = 3;
const TOOLTIP = "Plan limits used. Usage lists every agent's limits, tokens, and cost.";

type Props = {
  /** Undefined while the first reading loads. */
  readings: readonly PlanLimitReading[] | undefined;
  providers: readonly ProviderDiscovery[] | undefined;
  /** Undefined until the saved accounts have loaded. */
  accounts: readonly Account[] | undefined;
  now: number;
  /** The limit key of the selected agent's login, to mark its row and keep it in view. */
  currentKey?: string | undefined;
  /** Agents switched off in Settings. */
  hidden?: readonly string[] | undefined;
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
 * How much of each login's plan limits is used, above Settings: one circle per limit the provider
 * reports, each with its reset. The numbers come from each agent's provider; the card opens Usage.
 */
export function SidebarUsageStrip({ readings, providers, accounts, now, currentKey, hidden, timeZone, onOpen }: Props) {
  const descriptionId = useId();
  const shown = readings?.filter((reading) => showsReading(reading) && !hidden?.includes(reading.provider)) ?? [];
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
        {reading.state === "ok" ? null : <span className="usage-strip-state">{LIMIT_STATE_TEXT[reading.state]}</span>}
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
  const { used, reset, tone } = windowDisplay(window, now, timeZone);
  return (
    <span className={`usage-strip-window${tone ? ` is-${tone}` : ""}`}>
      <LimitRing className="usage-strip-ring" percent={reset.passed ? 0 : used} />
      <span className="usage-strip-window-label">{windowLabel(window)}</span>
      <span className="usage-strip-window-percent">{reset.passed ? "–" : formatPercent(used)}</span>
      <span className="usage-strip-window-reset">{reset.text}</span>
    </span>
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
  const state = row.reading.state === "ok" ? "" : (row.reading.message ?? LIMIT_STATE_TEXT[row.reading.state]);
  return `${[parts.join("; "), state].filter(Boolean).join(". ")}${row.current ? ", selected agent" : ""}.`;
}
