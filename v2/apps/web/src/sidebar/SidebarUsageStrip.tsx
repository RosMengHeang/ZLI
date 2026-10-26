import type { Account, ProviderDiscovery, RuntimeProjection, ThreadUsageRecord } from "@zli-v2/contracts";
import { useCallback, useId, useMemo } from "react";

import { accountLabel, USUAL_LOGIN_LABEL } from "../accounts/accounts.js";
import { providerDisplayName } from "../agent/providers.js";
import { useRuntimeSelector } from "../runtime/RuntimeProvider.js";
import { Icon } from "../ui/Icon.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import { formatTokens, usageWindows } from "../usage/usage.js";

const EMPTY: readonly ThreadUsageRecord[] = [];
const MAX_ROWS = 3;
const TOOLTIP = "Tokens per agent. Cost is under Usage.";

type Props = {
  providers: readonly ProviderDiscovery[] | undefined;
  /** Undefined until the saved accounts have loaded. */
  accounts: readonly Account[] | undefined;
  now: number;
  /** The usage group key of the selected agent's account, to mark its row. */
  currentKey?: string | undefined;
  onOpen(): void;
};

/** Tokens per agent over the last 5 hours and 7 days, above Settings. The whole strip opens the Usage dialog. */
export function SidebarUsageStrip({ providers, accounts, now, currentKey, onOpen }: Props) {
  // The shell projection skips usage updates, so the strip reads them from the store itself.
  const records = useRuntimeSelector(useCallback((value: RuntimeProjection | undefined) => value?.usage ?? EMPTY, []));
  const windows = useMemo(() => usageWindows(records, now), [records, now]);
  const descriptionId = useId();

  if (windows.length === 0) {
    return (
      <button
        type="button"
        className="sidebar-usage-strip is-empty"
        aria-label="Token usage"
        aria-describedby={descriptionId}
        data-tooltip={TOOLTIP}
        onClick={onOpen}
      >
        <Icon name="gauge" size={13} />
        <span id={descriptionId}>{records.length === 0 ? "No usage yet" : "No tokens in the last 7 days"}</span>
      </button>
    );
  }

  const withAccounts = new Set(windows.filter((row) => row.accountId).map((row) => row.provider));
  const rows = windows.slice(0, MAX_ROWS).map((row) => ({
    ...row,
    name: providerDisplayName(row.provider, providers),
    account: row.accountId
      ? accountLabel(accounts, row.accountId)
      : withAccounts.has(row.provider)
        ? USUAL_LOGIN_LABEL
        : undefined,
    current: row.key === currentKey,
  }));
  const more = windows.length - rows.length;
  const description = [
    "Tokens in the last 5 hours and the last 7 days.",
    ...rows.map(
      (row) =>
        `${[row.name, row.account].filter(Boolean).join(", ")}: ${formatTokens(row.fiveHours)} in 5 hours, ${formatTokens(row.week)} this week${row.current ? ", selected agent" : ""}.`,
    ),
    more > 0 ? `${more} more.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      className="sidebar-usage-strip"
      aria-label="Token usage"
      aria-describedby={descriptionId}
      data-tooltip={TOOLTIP}
      onClick={onOpen}
    >
      <span id={descriptionId} className="sr-only">
        {description}
      </span>
      <span className="usage-strip-grid" aria-hidden="true">
        <span className="usage-strip-head">Tokens</span>
        <span className="usage-strip-head usage-strip-number">5h</span>
        <span className="usage-strip-head usage-strip-number">Week</span>
        {rows.map((row) => (
          <span className={`usage-strip-row${row.current ? " is-current" : ""}`} key={row.key}>
            <span className="usage-strip-name">
              <ProviderMark provider={row.provider} size={12} />
              <span className="usage-strip-provider">{row.name}</span>
              {row.account ? <span className="usage-strip-account">{row.account}</span> : null}
            </span>
            <span className={`usage-strip-number usage-strip-recent${row.fiveHours === 0 ? " is-zero" : ""}`}>
              {formatTokens(row.fiveHours)}
            </span>
            <span className="usage-strip-number">{formatTokens(row.week)}</span>
          </span>
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
