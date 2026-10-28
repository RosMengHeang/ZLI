import {
  type Account,
  PLAN_LIMIT_PROVIDERS,
  type PlanLimitReading,
  type ProviderDiscovery,
  USUAL_LOGIN_ACCOUNT_ID,
} from "@zli-v2/contracts";

import { accountLabel, USUAL_LOGIN_LABEL } from "../accounts/accounts.js";
import { listedDiscoveries, providerDisplayName } from "../agent/providers.js";
import { LimitRing } from "../limits/LimitRing.js";
import {
  allWindows,
  formatPercent,
  LIMIT_STATE_TEXT,
  limitKey,
  type PlanLimitsState,
  windowDisplay,
  windowLabel,
} from "../limits/limits.js";
import { LoadingState } from "../ui/Pane.js";
import { ProviderMark } from "../ui/ProviderMark.js";

type Props = {
  state: PlanLimitsState;
  providers: readonly ProviderDiscovery[] | undefined;
  accounts: readonly Account[] | undefined;
  now: number;
  /** For tests; the person's own time zone otherwise. */
  timeZone?: string;
};

type Row = { key: string; provider: string; account?: string; reading?: PlanLimitReading };

/**
 * Every login of every installed agent with its plan limits, in full. Agents ZLI cannot read limits
 * for are listed too, saying so, so none of them goes missing.
 */
export function PlanLimitsList({ state, providers, accounts, now, timeZone }: Props) {
  if (state.status === "loading") return <LoadingState className="usage-limits-loading" label="Checking plan limits" />;
  const rows = limitRows(state.readings, providers, accounts);
  return (
    <>
      {state.status === "error" ? (
        <p className="usage-limits-error" role="alert">
          Plan limits could not be checked. {state.message}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p className="usage-limits-empty">No agent CLIs were found on this computer.</p>
      ) : (
        <ul className="usage-limits">
          {rows.map((row) => (
            <LimitRow
              key={row.key}
              row={row}
              name={providerDisplayName(row.provider, providers)}
              now={now}
              timeZone={timeZone}
            />
          ))}
        </ul>
      )}
    </>
  );
}

export function limitRows(
  readings: readonly PlanLimitReading[],
  providers: readonly ProviderDiscovery[] | undefined,
  accounts: readonly Account[] | undefined,
): Row[] {
  const withAccounts = new Set(
    readings.filter((reading) => reading.accountId !== USUAL_LOGIN_ACCOUNT_ID).map((reading) => reading.provider),
  );
  const read: Row[] = readings.map((reading) => {
    const account =
      reading.accountId === USUAL_LOGIN_ACCOUNT_ID
        ? withAccounts.has(reading.provider)
          ? USUAL_LOGIN_LABEL
          : undefined
        : (accountLabel(accounts, reading.accountId) ?? "Account");
    return {
      key: limitKey(reading.provider, reading.accountId),
      provider: reading.provider,
      ...(account ? { account } : {}),
      reading,
    };
  });
  const unread: Row[] = listedDiscoveries(providers)
    .filter(
      (entry) => entry.status === "found" && !(PLAN_LIMIT_PROVIDERS as readonly string[]).includes(entry.provider),
    )
    .map((entry) => ({ key: entry.provider, provider: entry.provider }));
  return [...read, ...unread];
}

function LimitRow({ row, name, now, timeZone }: { row: Row; name: string; now: number; timeZone: string | undefined }) {
  const { reading } = row;
  const windows = reading ? allWindows(reading) : [];
  const state = reading?.state ?? "unavailable";
  const message = reading ? reading.message : `${name} does not report plan limits.`;
  const stale = state !== "ok";
  const scopes = windows.map((window) => window.scope);
  // Droid Core has three windows of its own, so its labels need the length to tell them apart.
  const label = (window: (typeof windows)[number]) =>
    window.scope && scopes.filter((scope) => scope === window.scope).length > 1 && window.durationMinutes
      ? `${window.scope} ${windowLabel({ ...window, scope: undefined }).toLowerCase()}`
      : windowLabel(window);
  return (
    <li className={`usage-limit${stale ? " is-stale" : ""}`}>
      <div className="usage-limit-who">
        <span className="usage-name">
          <ProviderMark provider={row.provider} size={14} />
          <span className="usage-limit-provider">{name}</span>
          {row.account ? <span className="usage-account">{row.account}</span> : null}
          {reading?.plan ? <span className="usage-limit-plan">{reading.plan}</span> : null}
        </span>
        {state === "ok" ? null : (
          <span className="usage-limit-status">
            <span className={`usage-limit-state${state === "unavailable" ? "" : " needs-action"}`}>
              {LIMIT_STATE_TEXT[state]}
            </span>
            {message ? <span className="usage-limit-message">{message}</span> : null}
          </span>
        )}
      </div>
      {windows.length > 0 ? (
        <ul className="usage-limit-windows" aria-label={`${name} limits`}>
          {windows.map((window) => {
            const { used, reset, tone } = windowDisplay(window, now, timeZone);
            return (
              <li
                key={`${window.kind ?? "usage"}:${window.scope ?? ""}:${window.durationMinutes ?? ""}`}
                className={`usage-limit-window${tone ? ` is-${tone}` : ""}`}
              >
                <LimitRing percent={reset.passed ? 0 : used} />
                <span className="usage-limit-window-label" title={label(window)}>
                  {label(window)}
                </span>
                <span className="usage-limit-window-percent">{reset.passed ? "–" : formatPercent(used)}</span>
                <span className="usage-limit-window-reset">{reset.text}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}
