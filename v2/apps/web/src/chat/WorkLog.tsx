import type { ThreadActivityProjection } from "@zli-v2/contracts";
import { useState } from "react";

import type { FileLinks } from "../files/FileIndex.js";
import { Button } from "../ui/Button.js";
import { Collapse } from "../ui/Collapse.js";
import { Icon, type IconName } from "../ui/Icon.js";
import { CopyButton } from "./CopyButton.js";
import { SourceChips } from "./Sources.js";
import { parseStackTrace, StackTrace } from "./StackTrace.js";
import { durationLabel, elapsedLabel, stepDuration, ThoughtStep } from "./Thought.js";

export { elapsedLabel };

type Activity = ThreadActivityProjection;

const kindIcon: Record<Activity["kind"], IconName> = {
  command: "terminal",
  "file-read": "eye",
  "file-edit": "pencil",
  search: "search",
  web: "globe",
  tool: "wrench",
  reasoning: "message",
};

/** Reads, searches, and lookups in a row fold into one "Explored" step; edits and commands stand alone. */
const EXPLORE = new Set<Activity["kind"]>(["file-read", "search", "web"]);

export type StepRow =
  | { kind: "explore"; key: string; entries: Activity[] }
  | { kind: "thought"; key: string; entry: Activity }
  | { kind: "step"; key: string; entry: Activity };

export function groupSteps(activities: readonly Activity[]): StepRow[] {
  const rows: StepRow[] = [];
  for (const entry of activities) {
    const last = rows.at(-1);
    if (entry.kind === "reasoning") {
      rows.push({ kind: "thought", key: entry.activityId, entry });
      continue;
    }
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

/** A run of lookups took from the first one's start to the last one's end; nothing while one still runs. */
export function groupDuration(entries: readonly Activity[]): number | undefined {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    if (stepDuration(entry) === undefined) return undefined;
    start = Math.min(start, Date.parse(entry.startedAt ?? ""));
    end = Math.max(end, Date.parse(entry.completedAt ?? ""));
  }
  return entries.length > 0 ? end - start : undefined;
}

function StepTime({ milliseconds }: { milliseconds: number | undefined }) {
  const label = durationLabel(milliseconds);
  return label ? <span className="step-time">{label}</span> : null;
}

/**
 * Wording agents use when the person, or a permission rule, refused a call. A bare "permission
 * denied" is left out: that is usually the file system answering a command.
 */
const DENIED =
  /\b(?:the user doesn't want to proceed|tool use was rejected|(?:denied|rejected|declined) by (?:the )?user|user (?:denied|rejected|declined)|permission to use \S+ (?:was|has been) denied)/iu;

/** What a step's status word says: a refused call reads as Denied, not as a failure of the tool. */
export function stepState(entry: Activity): Activity["status"] | "denied" {
  if (entry.status === "failed" && entry.detail && DENIED.test(entry.detail)) return "denied";
  return entry.status;
}

/** Long values stay three lines until opened; a value of this many characters is likely to need more. */
const CLAMP_LINES = 3;
const CLAMP_CHARS = 240;

function InputValue({ value }: { value: string }) {
  const [full, setFull] = useState(false);
  const long = value.split("\n").length > CLAMP_LINES || value.length > CLAMP_CHARS;
  return (
    <dd className={`step-input-value${long && !full ? " is-clamped" : ""}`}>
      {value}
      {long ? (
        <button className="step-more" type="button" onClick={() => setFull(!full)}>
          {full ? "less" : "more"}
        </button>
      ) : null}
    </dd>
  );
}

/** The arguments a tool was called with, one per line: the name dim, the value as written. */
function StepInputs({ input }: { input: NonNullable<Activity["input"]> }) {
  return (
    <dl className="step-input">
      {input.map((item, index) => (
        <div className="step-input-row" key={`${item.key}-${index.toString()}`}>
          <dt>{item.key}</dt>
          <InputValue value={item.value} />
        </div>
      ))}
    </dl>
  );
}

/** What a step opens to: its arguments, then its output, or its stack trace when it failed. */
function StepBody({
  entry,
  detail,
  links,
}: {
  entry: Activity;
  detail: string | undefined;
  links?: FileLinks | undefined;
}) {
  // Only a failed step is worth the parse: its output is where a stack trace would be.
  const trace = detail && entry.status === "failed" ? parseStackTrace(detail) : undefined;
  return (
    <>
      {entry.input?.length ? <StepInputs input={entry.input} /> : null}
      {trace && detail ? (
        <div className="step-detail is-trace">
          <StackTrace trace={trace} text={detail} links={links} />
        </div>
      ) : detail ? (
        <StepOutput text={detail} />
      ) : entry.status === "running" ? (
        <p className="step-pending">Running</p>
      ) : null}
    </>
  );
}

function stepDetail(entry: Activity): string | undefined {
  return entry.command ? [`$ ${entry.command}`, entry.detail].filter(Boolean).join("\n") : entry.detail;
}

/** Output this long or shorter shows whole; longer output keeps its first and last lines. */
const FOLD_AFTER = 8;
const FOLD_KEEP = 3;

/** The first and last lines of long output and how many lines sit between them. */
export function foldOutput(text: string): { head: string; hidden: number; tail: string } | undefined {
  const lines = text.split("\n");
  if (lines.length <= FOLD_AFTER) return undefined;
  return {
    head: lines.slice(0, FOLD_KEEP).join("\n"),
    hidden: lines.length - FOLD_KEEP * 2,
    tail: lines.slice(-FOLD_KEEP).join("\n"),
  };
}

function StepOutput({ text }: { text: string }) {
  const [full, setFull] = useState(false);
  const fold = full ? undefined : foldOutput(text);
  return (
    <div className="step-output">
      <pre className="step-detail">
        {fold ? (
          <>
            {fold.head}
            <button className="step-more" type="button" onClick={() => setFull(true)}>
              … +{fold.hidden} lines
            </button>
            {fold.tail}
          </>
        ) : (
          text
        )}
      </pre>
      <CopyButton text={text} className="step-copy" />
    </div>
  );
}

function rowStatus(entries: readonly Activity[]): Activity["status"] {
  if (entries.some((entry) => entry.status === "running")) return "running";
  if (entries.length > 0 && entries.every((entry) => entry.status === "failed")) return "failed";
  return "completed";
}

function StepStatus({ status }: { status: Activity["status"] | "denied" }) {
  // A running step shows it through the shimmer on its text; this keeps the state readable aloud.
  if (status === "running") return <span className="sr-only" role="img" aria-label="Running" />;
  if (status === "denied") return <span className="step-denied">Denied</span>;
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
  links,
}: {
  activities: readonly Activity[];
  onOpenFile?: ((path: string) => void) | undefined;
  /** Opens the files a failed step's stack trace names. */
  links?: FileLinks | undefined;
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
            const sources = sourcesOf(row.entries);
            return (
              <li className={`step is-explore is-${status}`} key={row.key}>
                <button
                  className="step-row"
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => toggle(row.key)}
                  title={row.entries.map((entry) => entry.title).join("\n")}
                >
                  <Icon name="search" size={13} className="step-icon" />
                  <span className={`step-verb${status === "running" ? " shimmer-text" : ""}`}>
                    {status === "running" ? "Exploring" : "Explored"}
                  </span>{" "}
                  <span className="step-muted">{exploreCounts(row.entries)}</span>
                  <Icon name="chevronRight" size={11} className="step-chevron" />
                  <StepStatus status={status} />
                  <StepTime milliseconds={status === "running" ? undefined : groupDuration(row.entries)} />
                </button>
                <Collapse open={expanded}>
                  <ol className="step-children">
                    {row.entries.map((entry) => (
                      <ExploreChild
                        key={entry.activityId}
                        entry={entry}
                        open={open.has(entry.activityId)}
                        onToggle={() => toggle(entry.activityId)}
                        links={links}
                      />
                    ))}
                  </ol>
                </Collapse>
                {sources.length > 0 ? <SourceChips urls={sources} /> : null}
              </li>
            );
          }
          const { entry } = row;
          if (row.kind === "thought") {
            return <ThoughtStep key={row.key} entry={entry} open={expanded} onToggle={() => toggle(row.key)} />;
          }
          if (entry.kind === "file-edit") return <EditStep key={row.key} entry={entry} onOpenFile={onOpenFile} />;
          const detail = stepDetail(entry);
          const opens = Boolean(detail || entry.input?.length);
          const mono = entry.kind === "command" && !entry.command;
          const running = entry.status === "running";
          return (
            <li className={`step is-${entry.kind} is-${entry.status}`} key={row.key}>
              <button
                className="step-row"
                type="button"
                aria-expanded={opens ? expanded : undefined}
                disabled={!opens}
                onClick={() => toggle(row.key)}
                title={entry.command ?? entry.title}
              >
                <Icon name={kindIcon[entry.kind]} size={13} className="step-icon" />
                <span className={`step-title${mono ? " is-mono" : ""}${running ? " shimmer-text" : ""}`}>
                  {entry.title}
                </span>
                {opens ? <Icon name="chevronRight" size={11} className="step-chevron" /> : null}
                <StepStatus status={stepState(entry)} />
                <StepTime milliseconds={stepDuration(entry)} />
              </button>
              {opens ? (
                <Collapse open={expanded}>
                  <StepBody entry={entry} detail={detail} links={links} />
                </Collapse>
              ) : null}
              {entry.urls?.length ? <SourceChips urls={entry.urls} /> : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** The pages a run of lookups read, each once, for the chips under it. */
function sourcesOf(entries: readonly Activity[]): NonNullable<Activity["urls"]> {
  const seen = new Set<string>();
  return entries.flatMap((entry) =>
    (entry.urls ?? []).filter((source) => {
      if (seen.has(source.url)) return false;
      seen.add(source.url);
      return true;
    }),
  );
}

/** One lookup inside an "Explored" step. One called with arguments, or with output, opens to show them. */
function ExploreChild({
  entry,
  open,
  onToggle,
  links,
}: {
  entry: Activity;
  open: boolean;
  onToggle(): void;
  links?: FileLinks | undefined;
}) {
  const opens = Boolean(entry.detail || entry.input?.length);
  const content = (
    <>
      <Icon name={kindIcon[entry.kind]} size={12} />
      <span className={`step-child-title${entry.status === "running" ? " shimmer-text" : ""}`}>{entry.title}</span>
      <StepStatus status={stepState(entry)} />
      <StepTime milliseconds={stepDuration(entry)} />
    </>
  );
  return (
    <li className={`step-child is-${entry.status}${opens ? " is-open-able" : ""}`} title={entry.title}>
      {opens ? (
        <button className="step-child-row" type="button" aria-expanded={open} onClick={onToggle}>
          {content}
        </button>
      ) : (
        content
      )}
      {opens ? (
        <Collapse open={open}>
          <StepBody entry={entry} detail={entry.detail} links={links} />
        </Collapse>
      ) : null}
    </li>
  );
}

function EditStep({ entry, onOpenFile }: { entry: Activity; onOpenFile?: ((path: string) => void) | undefined }) {
  const total = lineTotal(entry);
  const running = entry.status === "running";
  const files = entry.files ?? [];
  const [first] = files;
  const content = (
    <>
      <Icon name="pencil" size={13} className="step-icon" />
      <span className={`step-verb${running ? " shimmer-text" : ""}`}>
        {running ? "Editing" : "Edit"}
        {total ? ` ${plural(total, "line", "lines")}` : ""}
      </span>{" "}
      {first ? (
        <span className="step-file">
          <span className="step-file-name">{baseName(first)}</span>
          {entry.lines ? <LineCounts lines={entry.lines} /> : null}
        </span>
      ) : (
        <span className="step-title">{entry.title}</span>
      )}
      {files.length > 1 ? <span className="step-muted">and {files.length - 1} more</span> : null}
      {first && onOpenFile ? <Icon name="arrowRight" size={11} className="step-chevron" /> : null}
      <StepStatus status={stepState(entry)} />
      <StepTime milliseconds={stepDuration(entry)} />
    </>
  );
  return (
    <li className={`step is-file-edit is-${entry.status}`}>
      {first && onOpenFile ? (
        <button
          className="step-row"
          type="button"
          aria-label={`Open ${first}`}
          title={files.join("\n")}
          onClick={() => onOpenFile(first)}
        >
          {content}
        </button>
      ) : (
        <div className="step-row is-static" title={files.join("\n") || entry.title}>
          {content}
        </div>
      )}
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
