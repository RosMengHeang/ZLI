import type { ThreadActivityProjection } from "@zli-v2/contracts";
import { useState } from "react";

import { Button } from "../ui/Button.js";
import { Icon, type IconName } from "../ui/Icon.js";

type Activity = ThreadActivityProjection;

const kindIcon: Record<Activity["kind"], IconName> = {
  command: "terminal",
  "file-read": "eye",
  "file-edit": "pencil",
  search: "search",
  web: "globe",
  tool: "wrench",
};

/** Reads, searches, and lookups in a row fold into one "Explored" step; edits and commands stand alone. */
const EXPLORE = new Set<Activity["kind"]>(["file-read", "search", "web"]);

export type StepRow =
  | { kind: "explore"; key: string; entries: Activity[] }
  | { kind: "step"; key: string; entry: Activity };

export function groupSteps(activities: readonly Activity[]): StepRow[] {
  const rows: StepRow[] = [];
  for (const entry of activities) {
    const last = rows.at(-1);
    if (EXPLORE.has(entry.kind)) {
      if (last?.kind === "explore") last.entries.push(entry);
      else rows.push({ kind: "explore", key: `explore-${entry.activityId}`, entries: [entry] });
      continue;
    }
    rows.push({ kind: "step", key: entry.activityId, entry });
  }
  return rows;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "3 files, 1 search" for a run of lookups. */
export function exploreCounts(entries: readonly Activity[]): string {
  const files = new Set<string>();
  let unnamedReads = 0;
  let searches = 0;
  let web = 0;
  for (const entry of entries) {
    if (entry.kind === "file-read") {
      if (entry.files?.length) for (const file of entry.files) files.add(file);
      else unnamedReads += 1;
    } else if (entry.kind === "search") searches += 1;
    else web += 1;
  }
  const parts: string[] = [];
  const reads = files.size + unnamedReads;
  if (reads) parts.push(plural(reads, "file", "files"));
  if (searches) parts.push(plural(searches, "search", "searches"));
  if (web) parts.push(plural(web, "web page", "web pages"));
  return parts.join(", ");
}

export function lineTotal(entry: Activity): number | undefined {
  return entry.lines ? entry.lines.added + entry.lines.removed : undefined;
}

export function baseName(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/u, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
}

/** What the agent is doing right now, in a few words, for the line under the chat. */
export function liveStepLabel(entry: Activity): string {
  const file = entry.files?.[0] ? baseName(entry.files[0]) : undefined;
  switch (entry.kind) {
    case "file-read":
      return file ? `Reading ${file}` : "Reading files";
    case "file-edit":
      return file ? `Editing ${file}` : "Editing files";
    case "command":
      // A title that already describes the command reads fine on its own.
      return entry.command ? entry.title : `Running ${entry.title}`;
    case "search":
      return entry.title.replace(/^Search\b/u, "Searching for").replace(/^List\b/u, "Listing");
    case "web":
      return entry.title.replace(/^Fetch\b/u, "Opening").replace(/^Web search\b/u, "Searching the web for");
    default:
      return entry.title;
  }
}

/** Seconds as "8s", "1m 05s", or "1h 02m". */
export function elapsedLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function rowStatus(entries: readonly Activity[]): Activity["status"] {
  if (entries.some((entry) => entry.status === "running")) return "running";
  if (entries.length > 0 && entries.every((entry) => entry.status === "failed")) return "failed";
  return "completed";
}

function StepStatus({ status }: { status: Activity["status"] }) {
  if (status === "running") return <span className="spinner step-spinner" role="img" aria-label="Running" />;
  if (status === "failed") {
    return (
      <span className="step-failed">
        <Icon name="x" size={11} />
        Failed
      </span>
    );
  }
  return null;
}

function LineCounts({ lines }: { lines: NonNullable<Activity["lines"]> }) {
  return (
    <span className="step-counts">
      {lines.added > 0 ? <span className="is-add">+{lines.added}</span> : null}
      {lines.removed > 0 ? <span className="is-del">-{lines.removed}</span> : null}
    </span>
  );
}

/**
 * One turn's tool calls as flat steps: lookups fold into "Explored 3 files", edits show the file
 * and the lines they changed, and commands open to show their output.
 */
export function WorkSteps({
  activities,
  onOpenFile,
}: {
  activities: readonly Activity[];
  onOpenFile?: ((path: string) => void) | undefined;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const rows = groupSteps(activities);

  return (
    <section className="work-steps" aria-label="Steps">
      <ol className="step-list">
        {rows.map((row) => {
          const expanded = open.has(row.key);
          if (row.kind === "explore") {
            const status = rowStatus(row.entries);
            return (
              <li className={`step is-explore is-${status}`} key={row.key}>
                <button
                  className="step-row"
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => toggle(row.key)}
                  title={row.entries.map((entry) => entry.title).join("\n")}
                >
                  <span className="step-verb">{status === "running" ? "Exploring" : "Explored"}</span>{" "}
                  <span className="step-muted">{exploreCounts(row.entries)}</span>
                  <Icon name="chevronRight" size={11} className="step-chevron" />
                  <StepStatus status={status} />
                </button>
                {expanded ? (
                  <ol className="step-children">
                    {row.entries.map((entry) => (
                      <li className={`step-child is-${entry.status}`} key={entry.activityId} title={entry.title}>
                        <Icon name={kindIcon[entry.kind]} size={12} />
                        <span className="step-child-title">{entry.title}</span>
                        <StepStatus status={entry.status} />
                      </li>
                    ))}
                  </ol>
                ) : null}
              </li>
            );
          }
          const { entry } = row;
          if (entry.kind === "file-edit") return <EditStep key={row.key} entry={entry} onOpenFile={onOpenFile} />;
          const detail = entry.command ? [`$ ${entry.command}`, entry.detail].filter(Boolean).join("\n") : entry.detail;
          const mono = entry.kind === "command" && !entry.command;
          return (
            <li className={`step is-${entry.kind} is-${entry.status}`} key={row.key}>
              <button
                className="step-row"
                type="button"
                aria-expanded={detail ? expanded : undefined}
                disabled={!detail}
                onClick={() => toggle(row.key)}
                title={entry.command ?? entry.title}
              >
                <Icon name={kindIcon[entry.kind]} size={13} className="step-icon" />
                <span className={`step-title${mono ? " is-mono" : ""}`}>{entry.title}</span>
                {detail ? <Icon name="chevronRight" size={11} className="step-chevron" /> : null}
                <StepStatus status={entry.status} />
              </button>
              {expanded && detail ? <pre className="step-detail">{detail}</pre> : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function EditStep({ entry, onOpenFile }: { entry: Activity; onOpenFile?: ((path: string) => void) | undefined }) {
  const total = lineTotal(entry);
  const verb = entry.status === "running" ? "Editing" : "Edit";
  const files = entry.files ?? [];
  const [first] = files;
  return (
    <li className={`step is-file-edit is-${entry.status}`}>
      <div className="step-row is-static" title={files.join("\n") || entry.title}>
        <Icon name="pencil" size={13} className="step-icon" />
        <span className="step-verb">
          {verb}
          {total ? ` ${plural(total, "line", "lines")}` : ""}
        </span>{" "}
        {first ? (
          <button
            className="step-file"
            type="button"
            disabled={!onOpenFile}
            onClick={() => onOpenFile?.(first)}
            aria-label={`Open ${first}`}
          >
            <span className="step-file-name">{baseName(first)}</span>
            {entry.lines ? <LineCounts lines={entry.lines} /> : null}
          </button>
        ) : (
          <span className="step-title">{entry.title}</span>
        )}
        {files.length > 1 ? <span className="step-muted">and {files.length - 1} more</span> : null}
        <StepStatus status={entry.status} />
      </div>
    </li>
  );
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
