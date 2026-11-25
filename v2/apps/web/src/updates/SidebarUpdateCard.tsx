import type { ProviderUpdateInfo, UpdateStatus } from "@zli-v2/contracts";
import { useEffect, useState } from "react";

import { useRuntime } from "../runtime/RuntimeProvider.js";
import { Icon } from "../ui/Icon.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import {
  type AgentUpdatesState,
  pendingAgentUpdates,
  runAgentUpdate,
  runAllAgentUpdates,
  useAgentUpdateChecks,
  useAgentUpdates,
} from "./agentUpdatesStore.js";
import "./updates.css";

const DISMISSED_KEY = "zli.sidebar.updatesDismissed";
const MAX_ROWS = 4;
/** How long a finished agent update stays on the card, as a quiet confirmation. */
const DONE_SHOWN_MS = 6_000;

type AppLine = {
  title: string;
  detail: string;
  action?: { label: string; run(): void };
  percent?: number;
};

/** What the app row says, or nothing while there is no new version. */
export function appUpdateLine(
  status: UpdateStatus | undefined,
  handlers: { onRestart(): void; onOpenRelease(): void; onDownload(): void },
): AppLine | undefined {
  const state = status?.state;
  const from = status?.currentVersion;
  if (state?.status === "ready") {
    return {
      title: `ZLI ${state.version}`,
      detail: "Ready. Restart to finish.",
      action: { label: "Restart", run: handlers.onRestart },
    };
  }
  if (state?.status === "downloading") {
    return {
      title: `ZLI ${state.version}`,
      detail: `Downloading, ${Math.round(state.percent)}%`,
      percent: state.percent,
    };
  }
  if (state?.status === "available") {
    return {
      title: `ZLI ${state.version}`,
      detail: from ? `${from} → ${state.version}` : "A new version is out.",
      action: state.canAutoInstall
        ? { label: "Install", run: handlers.onDownload }
        : { label: "Download", run: handlers.onOpenRelease },
    };
  }
  return undefined;
}

export type AgentRow = {
  entry: ProviderUpdateInfo;
  state: "pending" | "running" | "done" | "failed";
  version?: string | undefined;
};

/** The agents the card lists: updating now, just updated, failed, or with a newer version waiting. */
export function agentRows(state: AgentUpdatesState, now: number): AgentRow[] {
  return (state.updates ?? []).flatMap((entry): AgentRow[] => {
    const note = state.notes[entry.provider];
    if (state.running.has(entry.provider)) return [{ entry, state: "running" }];
    if (note?.tone === "ok" && now - note.at < DONE_SHOWN_MS) return [{ entry, state: "done", version: note.version }];
    if (note?.tone === "error" && entry.status === "behind") return [{ entry, state: "failed" }];
    if (entry.status === "behind" && entry.canUpdate) return [{ entry, state: "pending" }];
    return [];
  });
}

/** The line under an agent's name: the versions it moves between, or how its update went. */
export function agentDetail(row: AgentRow): string {
  const { entry } = row;
  if (row.state === "running") return `Updating to ${entry.latest ?? "the newest version"}…`;
  if (row.state === "done") return row.version ? `Now on ${row.version}. New chats use it.` : "Updated.";
  if (row.state === "failed") return "Did not update. Open Settings to see why.";
  return `${entry.current} → ${entry.latest}`;
}

/**
 * New versions waiting, at the foot of the sidebar: ZLI itself, then each agent CLI it runs with the
 * versions it moves between. Gone when there is nothing to update; closing it hides it until a newer
 * version turns up. A finished agent update stays a few seconds as a confirmation, then leaves.
 */
export function SidebarUpdateCard({
  status,
  connected,
  onRestart,
  onOpenRelease,
  onDownload,
  onOpenSettings,
}: {
  status: UpdateStatus | undefined;
  /** Agent versions are only asked for once the runtime is up. */
  connected: boolean;
  onRestart(): void;
  onOpenRelease(): void;
  onDownload(): void;
  onOpenSettings(): void;
}) {
  const { dispatch } = useRuntime();
  useAgentUpdateChecks(dispatch, connected);
  const agents = useAgentUpdates();
  const now = useNowUntil(nextExpiry(agents));
  const app = appUpdateLine(status, { onRestart, onOpenRelease, onDownload });
  const [dismissed, setDismissed] = useState(readDismissed);

  const rows = agentRows(agents, now);
  const active = rows.some((row) => row.state === "running" || row.state === "done");
  const signature = [
    app ? `app:${app.title}` : "",
    ...pendingAgentUpdates(agents).map((entry) => `${entry.provider}:${entry.latest}`),
  ]
    .filter(Boolean)
    .join(",");
  if (!app && rows.length === 0) return null;
  if (!active && signature === dismissed && app?.percent === undefined) return null;

  const dismiss = () => {
    writeDismissed(signature);
    setDismissed(signature);
  };
  const waiting = rows.filter((row) => row.state === "pending").length;

  return (
    <section className="sidebar-update-card" aria-label="Updates">
      <div className="sidebar-update-head">
        <span className="sidebar-update-dot" aria-hidden="true" />
        <span className="sidebar-update-title">Updates</span>
        {active ? null : (
          <button
            type="button"
            className="sidebar-update-close"
            aria-label="Hide until the next update"
            onClick={dismiss}
          >
            <Icon name="x" size={12} />
          </button>
        )}
      </div>

      {app ? (
        <div className="sidebar-update-row">
          <span className="sidebar-update-icon" aria-hidden="true">
            <Icon name={app.action?.label === "Restart" ? "rotate" : "download"} size={13} />
          </span>
          <span className="sidebar-update-copy">
            <span className="sidebar-update-name">{app.title}</span>
            <span className="sidebar-update-detail" role="status">
              {app.detail}
            </span>
            {app.percent !== undefined ? (
              <span className="sidebar-update-progress" aria-hidden="true">
                <span style={{ width: `${app.percent}%` }} />
              </span>
            ) : null}
          </span>
          {app.action ? (
            <button type="button" className="sidebar-update-action" onClick={app.action.run}>
              {app.action.label}
            </button>
          ) : null}
        </div>
      ) : null}

      {rows.slice(0, MAX_ROWS).map((row) => (
        <div key={row.entry.provider} className={`sidebar-update-row is-${row.state}`}>
          <span className="sidebar-update-icon" aria-hidden="true">
            <ProviderMark provider={row.entry.provider} size={13} />
          </span>
          <button type="button" className="sidebar-update-copy is-link" onClick={onOpenSettings}>
            <span className="sidebar-update-name">{row.entry.displayName}</span>
            <span className="sidebar-update-detail" role="status">
              {agentDetail(row)}
            </span>
          </button>
          {row.state === "running" ? (
            <span className="sidebar-update-spinner spinner" aria-hidden="true" />
          ) : row.state === "done" ? (
            <Icon name="check" size={14} className="sidebar-update-done" aria-hidden="true" />
          ) : (
            <button
              type="button"
              className="sidebar-update-action"
              onClick={() => void runAgentUpdate(dispatch, row.entry.provider)}
            >
              {row.state === "failed" ? "Retry" : "Update"}
            </button>
          )}
        </div>
      ))}
      {waiting > 1 ? (
        <button type="button" className="sidebar-update-all" onClick={() => runAllAgentUpdates(dispatch)}>
          Update all
        </button>
      ) : null}
      {rows.length > MAX_ROWS ? (
        <button type="button" className="sidebar-update-more" onClick={onOpenSettings}>
          {rows.length - MAX_ROWS} more in Settings
        </button>
      ) : null}
    </section>
  );
}

function nextExpiry(state: AgentUpdatesState): number | undefined {
  const now = Date.now();
  const ends = Object.values(state.notes)
    .flatMap((note) => (note?.tone === "ok" ? [note.at + DONE_SHOWN_MS] : []))
    .filter((end) => end > now);
  return ends.length > 0 ? Math.min(...ends) : undefined;
}

/** The time now, read again at `until` so a finished row leaves on its own. */
function useNowUntil(until: number | undefined): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (until === undefined) return;
    const timer = setTimeout(() => setTick((tick) => tick + 1), Math.max(0, until - Date.now()) + 20);
    return () => clearTimeout(timer);
  }, [until]);
  return Date.now();
}

function readDismissed(): string {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeDismissed(signature: string): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, signature);
  } catch {
    // Storage can be blocked; the card then only hides for this window.
  }
}
