import type { RuntimeProjection, UsageModelRow, UsageProviderRow, UsageRange, UsageReport } from "@zli-v2/contracts";

import { useState } from "react";

import { providerDisplayName } from "../agent/providers.js";
import { Button } from "../ui/Button.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import { Segmented } from "../ui/Segmented.js";
import { formatTokens } from "../usage/usage.js";
import {
  type ChartBar,
  chartBars,
  formatUsd,
  totalTokens,
  USAGE_RANGE_OPTIONS,
  useUsageReport,
  WEEKLY_AFTER_DAYS,
} from "../usage/usageReport.js";
import { SettingsGroup, SettingsPageHeader } from "./SettingsLayout.js";
import "./usageReport.css";

type Metric = "cost" | "tokens";
type Providers = RuntimeProjection["providers"] | undefined;

const METRICS: readonly { value: Metric; label: string }[] = [
  { value: "cost", label: "Cost" },
  { value: "tokens", label: "Tokens" },
];

/** Tokens and cost from the agents' own session logs, by day, agent, and model. */
export function UsageSection({ projection }: { projection: RuntimeProjection | undefined }) {
  const [range, setRange] = useState<UsageRange>("30d");
  const [metric, setMetric] = useState<Metric>("cost");
  const { state, reload } = useUsageReport(range);
  const report = state.report;
  const providers = projection?.providers;

  return (
    <>
      <SettingsPageHeader title="Usage">
        Tokens and cost from Claude Code and Codex session logs on this computer. Cost uses each model's API price, so
        on a subscription it shows what the same work would cost through the API.
      </SettingsPageHeader>
      <div className="usage-report-controls">
        <Segmented<UsageRange> label="Range" value={range} options={USAGE_RANGE_OPTIONS} onChange={setRange} />
        <Segmented<Metric> label="Show" value={metric} options={METRICS} onChange={setMetric} />
      </div>
      {state.status === "error" ? (
        <div className="usage-report-error" role="alert">
          <p>{state.message}</p>
          <Button size="sm" onClick={reload}>
            Try again
          </Button>
        </div>
      ) : null}
      {!report ? (
        state.status === "loading" ? (
          <p className="settings-empty" role="status">
            Reading session logs…
          </p>
        ) : null
      ) : report.totals.requests === 0 ? (
        <p className="settings-empty">
          {range === "all" ? "No agent use found on this computer yet." : "No agent use in this range."}
        </p>
      ) : (
        <div className="usage-report" aria-busy={state.status === "loading"}>
          <Totals report={report} />
          <DailyChart report={report} metric={metric} />
          <ProviderTable rows={report.providers} providers={providers} />
          <ModelTable rows={report.models} providers={providers} />
        </div>
      )}
    </>
  );
}

function Totals({ report }: { report: UsageReport }) {
  const { tokens, costUsd, unpricedTokens } = report.totals;
  const items: { label: string; value: string }[] = [
    { label: "Cost", value: formatUsd(costUsd) },
    { label: "Tokens", value: formatTokens(totalTokens(tokens)) },
    { label: "Input", value: formatTokens(tokens.input) },
    { label: "Output", value: formatTokens(tokens.output) },
    { label: "Cache read", value: formatTokens(tokens.cacheRead) },
    { label: "Cache write", value: formatTokens(tokens.cacheWrite) },
  ];
  return (
    <section className="usage-report-section" aria-label="Totals">
      <dl className="usage-report-totals">
        {items.map((item) => (
          <div key={item.label} className="usage-report-total">
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
          </div>
        ))}
      </dl>
      {unpricedTokens > 0 ? (
        <p className="usage-report-note">
          Cost leaves out {formatTokens(unpricedTokens)} tokens from models without a known price.
        </p>
      ) : null}
    </section>
  );
}

function barValue(bar: ChartBar, metric: Metric): number {
  return metric === "cost" ? bar.costUsd : bar.tokens;
}

function formatValue(value: number, metric: Metric): string {
  return metric === "cost" ? formatUsd(value) : formatTokens(value);
}

function DailyChart({ report, metric }: { report: UsageReport; metric: Metric }) {
  const bars = chartBars(report.days);
  const weekly = report.days.length > WEEKLY_AFTER_DAYS;
  const [pointed, setPointed] = useState<string | undefined>(undefined);
  const max = Math.max(0, ...bars.map((bar) => barValue(bar, metric)));
  const shown = bars.find((bar) => bar.key === pointed) ?? bars.at(-1);
  const title = `${weekly ? "Weekly" : "Daily"} ${metric === "cost" ? "cost" : "tokens"}`;

  return (
    <SettingsGroup title={title} bare>
      <div className="usage-chart">
        <div className="usage-chart-scale" aria-hidden="true">
          <span>{formatValue(max, metric)}</span>
          <span>{formatValue(0, metric)}</span>
        </div>
        <div className="usage-chart-plot">
          {/* biome-ignore lint/a11y/noStaticElementInteractions: pointing only previews a bar; the tables hold every number. */}
          <div className="usage-chart-bars" onMouseLeave={() => setPointed(undefined)}>
            {bars.map((bar) => {
              const value = barValue(bar, metric);
              const height = max > 0 ? (value / max) * 100 : 0;
              return (
                <button
                  key={bar.key}
                  type="button"
                  className={`usage-chart-bar${bar.key === shown?.key ? " is-shown" : ""}`}
                  aria-label={`${bar.label}: ${formatValue(value, metric)}`}
                  onMouseEnter={() => setPointed(bar.key)}
                  onFocus={() => setPointed(bar.key)}
                  onClick={() => setPointed(bar.key)}
                >
                  <span className="usage-chart-fill" style={{ height: value > 0 ? `max(2px, ${height}%)` : 0 }} />
                </button>
              );
            })}
          </div>
          <div className="usage-chart-axis" aria-hidden="true">
            <span>{bars[0]?.label}</span>
            <span>{bars.at(-1)?.label}</span>
          </div>
        </div>
      </div>
      {shown ? <BarDetail bar={shown} metric={metric} /> : null}
    </SettingsGroup>
  );
}

function BarDetail({ bar, metric }: { bar: ChartBar; metric: Metric }) {
  const slices = [...bar.providers].sort((left, right) =>
    metric === "cost" ? right.costUsd - left.costUsd : right.tokens - left.tokens,
  );
  return (
    <p className="usage-chart-detail" aria-live="polite">
      <span className="usage-chart-detail-date">{bar.label}</span>
      <span>
        {formatUsd(bar.costUsd)} · {formatTokens(bar.tokens)} tokens
      </span>
      {slices.length > 1
        ? slices.map((slice) => (
            <span key={slice.provider} className="usage-chart-detail-slice">
              <ProviderMark provider={slice.provider} size={12} />
              {formatValue(metric === "cost" ? slice.costUsd : slice.tokens, metric)}
            </span>
          ))
        : null}
    </p>
  );
}

function ProviderTable({ rows, providers }: { rows: readonly UsageProviderRow[]; providers: Providers }) {
  return (
    <SettingsGroup title="By agent" bare>
      <div className="usage-report-scroll">
        <table className="usage-report-table">
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">Requests</th>
              <th scope="col">Tokens</th>
              <th scope="col">Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.provider}>
                <th scope="row">
                  <span className="usage-report-name">
                    <ProviderMark provider={row.provider} size={14} />
                    <span>{providerDisplayName(row.provider, providers)}</span>
                  </span>
                </th>
                <td>{row.requests.toLocaleString("en-US")}</td>
                <td>{formatTokens(totalTokens(row.tokens))}</td>
                <td>
                  {formatUsd(row.costUsd)}
                  {row.unpricedTokens > 0 ? <span className="usage-report-partial"> + unknown</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SettingsGroup>
  );
}

function ModelTable({ rows, providers }: { rows: readonly UsageModelRow[]; providers: Providers }) {
  return (
    <SettingsGroup title="By model" bare>
      <div className="usage-report-scroll">
        <table className="usage-report-table">
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col">Input</th>
              <th scope="col">Output</th>
              <th scope="col">Cache read</th>
              <th scope="col">Cache write</th>
              <th scope="col">Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.provider}:${row.model}`}>
                <th scope="row">
                  <span className="usage-report-name" title={providerDisplayName(row.provider, providers)}>
                    <ProviderMark provider={row.provider} size={14} />
                    <span className="usage-report-model">{row.model}</span>
                  </span>
                </th>
                <td>{formatTokens(row.tokens.input)}</td>
                <td>{formatTokens(row.tokens.output)}</td>
                <td>{formatTokens(row.tokens.cacheRead)}</td>
                <td>{formatTokens(row.tokens.cacheWrite)}</td>
                <td className={row.priced ? undefined : "is-unknown"}>
                  {row.priced ? formatUsd(row.costUsd) : "Unknown"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.some((row) => !row.priced) ? (
        <p className="usage-report-note">Unknown means ZLI has no price for that model. Its tokens still count.</p>
      ) : null}
    </SettingsGroup>
  );
}
