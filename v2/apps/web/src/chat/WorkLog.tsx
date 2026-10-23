import type { ThreadActivityProjection } from "@zli-v2/contracts";
import { useMemo, useState } from "react";

import { Badge } from "../ui/Badge.js";
import { Button } from "../ui/Button.js";
import { Icon, type IconName } from "../ui/Icon.js";

const kindIcon: Record<ThreadActivityProjection["kind"], IconName> = {
  command: "terminal",
  "file-read": "eye",
  "file-edit": "pencil",
  search: "search",
  web: "globe",
  tool: "wrench",
};

const COLLAPSED_VISIBLE = 4;

export function workSummary(activities: readonly ThreadActivityProjection[]): string {
  const count = (kind: ThreadActivityProjection["kind"]) => activities.filter((entry) => entry.kind === kind).length;
  const editedFiles = new Set(
    activities.filter((entry) => entry.kind === "file-edit").flatMap((entry) => entry.files ?? [entry.title]),
  ).size;
  const parts: string[] = [];
  const commands = count("command");
  if (commands) parts.push(`ran ${commands} ${commands === 1 ? "command" : "commands"}`);
  if (editedFiles) parts.push(`edited ${editedFiles} ${editedFiles === 1 ? "file" : "files"}`);
  const reads = count("file-read");
  if (reads) parts.push(`read ${reads} ${reads === 1 ? "file" : "files"}`);
  const searches = count("search") + count("web");
  if (searches) parts.push(`${searches} ${searches === 1 ? "search" : "searches"}`);
  const tools = count("tool");
  if (tools) parts.push(`${tools} other ${tools === 1 ? "tool call" : "tool calls"}`);
  const sentence = parts.join(", ");
  return sentence ? sentence.charAt(0).toUpperCase() + sentence.slice(1) : "No tool calls";
}

type Activity = ThreadActivityProjection;

/** Consecutive lookups of one kind fold into a single row; edits and commands always stay visible. */
const GROUPABLE = new Set<Activity["kind"]>(["file-read", "search", "web"]);

export type WorkRow =
  | { kind: "entry"; key: string; entry: Activity }
  | { kind: "group"; key: string; activityKind: Activity["kind"]; entries: Activity[] };

export function groupActivities(activities: readonly Activity[]): WorkRow[] {
  const rows: WorkRow[] = [];
  let run: Activity[] = [];
  const flush = () => {
    const first = run[0];
    if (!first) return;
    if (run.length === 1) rows.push({ kind: "entry", key: first.activityId, entry: first });
    else rows.push({ kind: "group", key: `group-${first.activityId}`, activityKind: first.kind, entries: run });
    run = [];
  };
  for (const entry of activities) {
    if (GROUPABLE.has(entry.kind) && (run.length === 0 || run[0]?.kind === entry.kind)) {
      run.push(entry);
      continue;
    }
    flush();
    if (GROUPABLE.has(entry.kind)) run.push(entry);
    else rows.push({ kind: "entry", key: entry.activityId, entry });
  }
  flush();
  return rows;
}

export function groupLabel(kind: Activity["kind"], count: number): string {
  if (kind === "file-read") return `Read ${count} files`;
  if (kind === "web") return `${count} web lookups`;
  return `${count} searches`;
}

function groupStatus(entries: readonly Activity[]): Activity["status"] {
  if (entries.some((entry) => entry.status === "running")) return "running";
  if (entries.some((entry) => entry.status === "failed")) return "failed";
  return "completed";
}

function StatusMark({ status }: { status: Activity["status"] }) {
  return (
    <span className="work-entry-status">
      {status === "running" ? (
        <span className="spinner" role="img" aria-label="Running" />
      ) : status === "failed" ? (
        <Icon name="x" size={12} aria-label="Failed" />
      ) : (
        <Icon name="check" size={12} aria-label="Done" />
      )}
    </span>
  );
}

export function WorkLog({ activities, running }: { activities: readonly Activity[]; running: boolean }) {
  const [expanded, setExpanded] = useState<boolean>();
  const [openDetail, setOpenDetail] = useState<string>();
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());
  const open = expanded ?? running;
  const failed = activities.filter((entry) => entry.status === "failed").length;
  const rows = useMemo(() => groupActivities(activities), [activities]);
  const visible = open ? rows : rows.slice(-COLLAPSED_VISIBLE);
  const hidden = rows.length - visible.length;

  const toggleGroup = (key: string) =>
    setOpenGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const renderEntry = (entry: Activity) => {
    const detailOpen = openDetail === entry.activityId;
    return (
      <li className={`work-entry is-${entry.status}`} key={entry.activityId}>
        <button
          className="work-entry-row"
          type="button"
          aria-expanded={entry.detail ? detailOpen : undefined}
          disabled={!entry.detail}
          onClick={() => setOpenDetail(detailOpen ? undefined : entry.activityId)}
          title={entry.title}
        >
          <Icon name={kindIcon[entry.kind]} size={13} className="work-entry-icon" />
          <span className={`work-entry-title${entry.kind === "command" ? " is-mono" : ""}`}>{entry.title}</span>
          <StatusMark status={entry.status} />
        </button>
        {detailOpen && entry.detail ? <pre className="work-entry-detail">{entry.detail}</pre> : null}
      </li>
    );
  };

  return (
    <section className={`work-log${running ? " is-running" : ""}`} aria-label="Work log">
      <button className="work-log-header" type="button" aria-expanded={open} onClick={() => setExpanded(!open)}>
        <Icon name="chevronRight" size={12} className="work-log-chevron" />
        <span className="work-log-summary">{workSummary(activities)}</span>
        {running ? <span className="spinner work-log-spinner" aria-hidden="true" /> : null}
        {failed > 0 ? <Badge tone="danger">{failed} failed</Badge> : null}
      </button>
      {open || running ? (
        <ol className="work-log-list">
          {hidden > 0 ? (
            <li>
              <button className="work-log-more" type="button" onClick={() => setExpanded(true)}>
                Show {hidden} earlier
              </button>
            </li>
          ) : null}
          {visible.map((row) => {
            if (row.kind === "entry") return renderEntry(row.entry);
            const groupOpen = openGroups.has(row.key);
            const status = groupStatus(row.entries);
            return (
              <li className={`work-entry work-group is-${status}`} key={row.key}>
                <button
                  className="work-entry-row"
                  type="button"
                  aria-expanded={groupOpen}
                  onClick={() => toggleGroup(row.key)}
                  title={row.entries.map((entry) => entry.title).join("\n")}
                >
                  <Icon name={kindIcon[row.activityKind]} size={13} className="work-entry-icon" />
                  <span className="work-entry-title">
                    {groupLabel(row.activityKind, row.entries.length)}
                    <span className="work-group-preview">{groupPreview(row.entries)}</span>
                  </span>
                  <Icon name="chevronRight" size={11} className="work-group-chevron" />
                  <StatusMark status={status} />
                </button>
                {groupOpen ? <ol className="work-group-list">{row.entries.map(renderEntry)}</ol> : null}
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}

/** The last part of each title, so a folded row still hints at which files or queries it holds. */
function groupPreview(entries: readonly Activity[]): string {
  return entries
    .slice(0, 4)
    .map((entry) => {
      const file = entry.kind === "file-read" ? entry.files?.[0]?.replaceAll("\\", "/") : undefined;
      return file ? file.slice(file.lastIndexOf("/") + 1) : entry.title;
    })
    .join(", ");
}
export function ChangedFiles({ files, onOpenDiff }: { files: readonly string[]; onOpenDiff(path?: string): void }) {
  return (
    <section className="changed-files" aria-label="Changed files">
      <header className="changed-files-header">
        <Icon name="diff" size={13} />
        <span>
          {files.length} {files.length === 1 ? "file" : "files"} changed
        </span>
        <Button variant="ghost" size="xs" onClick={() => onOpenDiff()}>
          Open diff
        </Button>
      </header>
      <ul className="changed-files-list">
        {files.slice(0, 12).map((file) => {
          const normalized = file.replaceAll("\\", "/");
          const slash = normalized.lastIndexOf("/");
          return (
            <li key={file}>
              <button type="button" onClick={() => onOpenDiff(file)} title={file}>
                <Icon name="file" size={12} />
                <span className="changed-file-name">{normalized.slice(slash + 1)}</span>
                {slash > 0 ? <span className="changed-file-dir">{normalized.slice(0, slash)}</span> : null}
              </button>
            </li>
          );
        })}
        {files.length > 12 ? <li className="changed-files-more">and {files.length - 12} more</li> : null}
      </ul>
    </section>
  );
}
