import type { RuntimeProjection, ThreadUsageRecord } from "@zli-v2/contracts";
import { type ReactNode, useCallback, useMemo, useState } from "react";

import { providerDisplayName } from "../agent/providers.js";
import { useRuntimeSelector } from "../runtime/RuntimeProvider.js";
import { relativeTime } from "../sessions/sessions.js";
import { Dialog } from "../ui/Dialog.js";
import { Select } from "../ui/Field.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import {
  filterUsage,
  formatCost,
  formatTokens,
  groupUsage,
  sumUsage,
  type UsageGroup,
  type UsagePeriod,
  type UsageTotals,
  usagePeriods,
} from "./usage.js";
import "./usage.css";

const EMPTY: readonly ThreadUsageRecord[] = [];
const MAX_CHAT_ROWS = 50;

type Props = {
  projection: RuntimeProjection | undefined;
  initialProjectId?: string | undefined;
  onClose(): void;
};

export function UsageDialog({ projection, initialProjectId, onClose }: Props) {
  // The shell projection skips usage updates, so the dialog reads them from the store itself.
  const records = useRuntimeSelector(useCallback((value: RuntimeProjection | undefined) => value?.usage ?? EMPTY, []));
  const messages = useRuntimeSelector(useCallback((value: RuntimeProjection | undefined) => value?.messages, []));
  const [period, setPeriod] = useState<UsagePeriod>("week");
  const projects = projection?.projects ?? [];
  const [projectId, setProjectId] = useState(
    projects.some((project) => project.projectId === initialProjectId) ? initialProjectId : undefined,
  );
  const [now] = useState(() => Date.now());
  const visible = useMemo(() => filterUsage(records, { period, projectId, now }), [records, period, projectId, now]);
  const totals = useMemo(() => sumUsage(visible), [visible]);
  const agents = useMemo(() => groupUsage(visible, "provider"), [visible]);
  const chats = useMemo(() => groupUsage(visible, "thread").slice(0, MAX_CHAT_ROWS), [visible]);
  const providerName = (provider: string) => providerDisplayName(provider, projection?.providers);
  const silentOnCost = agents.filter((group) => group.totals.costedTurns === 0).map((group) => group.provider);
  const titles = useMemo(() => chatTitles(messages), [messages]);
  const liveThreads = new Set<string>(projection?.threads.map((thread) => thread.threadId));
  const projectName = (id: string | undefined) => projects.find((project) => project.projectId === id)?.name;
  const cursorInstalled = projection?.providers?.some(
    (entry) => entry.provider === "cursor-agent" && entry.status === "found",
  );

  return (
    <Dialog label="Usage" title="Usage" size="lg" className="usage-dialog" scrimLabel="Close usage" onClose={onClose}>
      <div className="usage-body">
        <div className="usage-filters">
          <Select
            className="input-sm"
            aria-label="Period"
            value={period}
            onChange={(event) => setPeriod(event.target.value as UsagePeriod)}
          >
            {usagePeriods.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </Select>
          {projects.length > 1 ? (
            <Select
              className="input-sm"
              aria-label="Project"
              value={projectId ?? ""}
              onChange={(event) => setProjectId((event.target.value || undefined) as typeof projectId)}
            >
              <option value="">All projects</option>
              {projects.map((project) => (
                <option key={project.projectId} value={project.projectId}>
                  {project.name}
                </option>
              ))}
            </Select>
          ) : null}
        </div>
        {records.length === 0 ? (
          <p className="usage-empty">
            No usage yet. Agents in chat view report their tokens after each turn, and the totals show up here.
          </p>
        ) : visible.length === 0 ? (
          <p className="usage-empty">No agent turns in this period.</p>
        ) : (
          <>
            <UsageSummary totals={totals} />
            <section className="usage-section" aria-labelledby="usage-agents">
              <h3 className="usage-heading" id="usage-agents">
                By agent
              </h3>
              <UsageTable
                label="Agent"
                rows={agents}
                name={(group) => (
                  <span className="usage-name">
                    <ProviderMark provider={group.provider} size={14} />
                    {providerName(group.provider)}
                  </span>
                )}
              />
            </section>
            <section className="usage-section" aria-labelledby="usage-chats">
              <h3 className="usage-heading" id="usage-chats">
                Recent chats
              </h3>
              <UsageTable
                label="Chat"
                rows={chats}
                name={(group) => {
                  const record = visible.find((entry) => entry.threadId === group.key);
                  const title = titles.get(group.key) ?? providerName(group.provider);
                  const project = projectName(record?.projectId);
                  return (
                    <span className="usage-name">
                      <ProviderMark provider={group.provider} size={14} />
                      <span className="usage-chat">
                        <span className="usage-chat-title" title={title}>
                          {title}
                        </span>
                        <span className="usage-chat-meta">
                          {[
                            project,
                            liveThreads.has(group.key) ? undefined : "Deleted",
                            relativeTime(new Date(group.lastAt).toISOString(), now),
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                    </span>
                  );
                }}
              />
            </section>
          </>
        )}
        <p className="usage-note">
          Numbers come from what each agent reports, and cost is the agent's own estimate, not your bill. Agents in
          terminal view are not counted.
          {silentOnCost.length > 0
            ? ` ${listNames(silentOnCost.map(providerName))} ${silentOnCost.length === 1 ? "does" : "do"} not report cost.`
            : ""}
          {cursorInstalled ? ` ${providerName("cursor-agent")} does not report usage, so its chats are not here.` : ""}
        </p>
      </div>
    </Dialog>
  );
}

function UsageSummary({ totals }: { totals: UsageTotals }) {
  return (
    <dl className="usage-summary">
      <div>
        <dt>Turns</dt>
        <dd>{totals.turns.toLocaleString()}</dd>
      </div>
      <div>
        <dt>Input tokens</dt>
        <dd>
          {formatTokens(totals.inputTokens)}
          {totals.cachedInputTokens > 0 ? (
            <span className="usage-sub">{formatTokens(totals.cachedInputTokens)} cached</span>
          ) : null}
        </dd>
      </div>
      <div>
        <dt>Output tokens</dt>
        <dd>{formatTokens(totals.outputTokens)}</dd>
      </div>
      <div>
        <dt>Estimated cost</dt>
        <dd>
          {totals.costedTurns > 0 ? formatCost(totals.costUsd) : "Not reported"}
          {totals.costedTurns > 0 && totals.costedTurns < totals.turns ? (
            <span className="usage-sub">
              {totals.costedTurns} of {totals.turns} turns
            </span>
          ) : null}
        </dd>
      </div>
    </dl>
  );
}

function UsageTable({
  label,
  rows,
  name,
}: {
  label: string;
  rows: readonly UsageGroup[];
  name(group: UsageGroup): ReactNode;
}) {
  return (
    <table className="usage-table">
      <thead>
        <tr>
          <th scope="col">{label}</th>
          <th scope="col">Turns</th>
          <th scope="col">Input</th>
          <th scope="col">Output</th>
          <th scope="col">Cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((group) => (
          <tr key={group.key}>
            <th scope="row">{name(group)}</th>
            <td>{group.totals.turns.toLocaleString()}</td>
            <td>{formatTokens(group.totals.inputTokens)}</td>
            <td>{formatTokens(group.totals.outputTokens)}</td>
            <td className={group.totals.costedTurns === 0 ? "is-missing" : undefined}>
              {group.totals.costedTurns === 0 ? "Not reported" : formatCost(group.totals.costUsd)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function chatTitles(messages: RuntimeProjection["messages"]): ReadonlyMap<string, string> {
  const titles = new Map<string, string>();
  for (const message of messages ?? []) {
    if (message.role !== "user" || titles.has(message.threadId)) continue;
    const line = message.text.trim().split(/\r?\n/u)[0]?.trim();
    if (line) titles.set(message.threadId, line.length > 72 ? `${line.slice(0, 71)}…` : line);
  }
  return titles;
}

function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
