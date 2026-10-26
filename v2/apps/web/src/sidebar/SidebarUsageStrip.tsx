import type { Account, ProviderDiscovery, RuntimeProjection, ThreadUsageRecord } from "@zli-v2/contracts";
import { useCallback, useId, useMemo } from "react";

import { accountLabel, USUAL_LOGIN_LABEL } from "../accounts/accounts.js";
import { providerDisplayName } from "../agent/providers.js";
import { useRuntimeSelector } from "../runtime/RuntimeProvider.js";
import { Icon } from "../ui/Icon.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import { formatCost, formatTokens, stripUsage, tokenTotal, type UsageTotals } from "../usage/usage.js";

const EMPTY: readonly ThreadUsageRecord[] = [];
const MAX_ROWS = 3;
const periodLabel = { today: "Today", week: "Last 7 days" } as const;

type Props = {
  providers: readonly ProviderDiscovery[] | undefined;
  /** Undefined until the saved accounts have loaded. */
  accounts: readonly Account[] | undefined;
  now: number;
  /** The usage group key of the selected agent's account, to mark its row. */
  currentKey?: string | undefined;
  onOpen(): void;
};

function amount(totals: UsageTotals): string {
  return totals.costedTurns > 0 ? formatCost(totals.costUsd) : `${formatTokens(tokenTotal(totals))} tokens`;
}

/** A compact per-account summary above Settings. The whole strip opens the Usage dialog. */
export function SidebarUsageStrip({ providers, accounts, now, currentKey, onOpen }: Props) {
  // The shell projection skips usage updates, so the strip reads them from the store itself.
  const records = useRuntimeSelector(useCallback((value: RuntimeProjection | undefined) => value?.usage ?? EMPTY, []));
  const strip = useMemo(() => stripUsage(records, now), [records, now]);
  const descriptionId = useId();

  if (!strip) {
    return (
      <button
        type="button"
        className="sidebar-usage-strip is-empty"
        aria-label="Usage"
        aria-describedby={descriptionId}
        data-tooltip="Usage and cost"
        onClick={onOpen}
      >
        <Icon name="gauge" size={13} />
        <span id={descriptionId}>No usage yet</span>
      </button>
    );
  }

  const withAccounts = new Set(strip.groups.filter((group) => group.accountId).map((group) => group.provider));
  const rows = strip.groups.slice(0, MAX_ROWS).map((group) => {
    const account = group.accountId
      ? accountLabel(accounts, group.accountId)
      : withAccounts.has(group.provider)
        ? USUAL_LOGIN_LABEL
        : undefined;
    return {
      group,
      provider: providerDisplayName(group.provider, providers),
      account,
      value: amount(group.totals),
      share: strip.maxTokens > 0 ? tokenTotal(group.totals) / strip.maxTokens : 0,
      current: group.key === currentKey,
    };
  });
  const more = strip.groups.length - rows.length;
  // Bars compare accounts with each other. With one account a full bar would read as a used-up quota.
  const compare = strip.groups.length > 1;
  const description = [
    `${periodLabel[strip.period]}, ${amount(strip.totals)} in all.`,
    ...rows.map(
      (row) =>
        `${[row.provider, row.account].filter(Boolean).join(", ")}: ${row.value}${row.current ? ", selected agent" : ""}.`,
    ),
    more > 0 ? `${more} more.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      className="sidebar-usage-strip"
      aria-label="Usage"
      aria-describedby={descriptionId}
      data-tooltip="Usage and cost"
      onClick={onOpen}
    >
      <span id={descriptionId} className="sr-only">
        {description}
      </span>
      <span className="usage-strip-head" aria-hidden="true">
        <span>{periodLabel[strip.period]}</span>
        <span className="usage-strip-total">{amount(strip.totals)}</span>
      </span>
      {rows.map((row) => (
        <span className={`usage-strip-row${row.current ? " is-current" : ""}`} key={row.group.key} aria-hidden="true">
          <ProviderMark provider={row.group.provider} size={12} />
          <span className="usage-strip-name">
            <span className="usage-strip-provider">{row.provider}</span>
            {row.account ? <span className="usage-strip-account">{row.account}</span> : null}
          </span>
          <span className="usage-strip-value">{row.value}</span>
          {compare ? (
            <span className="usage-strip-bar">
              <span style={{ width: `${Math.max(row.share * 100, 2)}%` }} />
            </span>
          ) : null}
        </span>
      ))}
      {more > 0 ? (
        <span className="usage-strip-more" aria-hidden="true">
          +{more} more
        </span>
      ) : null}
    </button>
  );
}
