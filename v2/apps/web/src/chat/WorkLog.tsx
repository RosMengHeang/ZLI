import type { ThreadActivityProjection } from "@zli-v2/contracts";
import { useState } from "react";

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

export function WorkLog({
  activities,
  running,
}: {
  activities: readonly ThreadActivityProjection[];
  running: boolean;
}) {
  const [expanded, setExpanded] = useState<boolean>();
  const [openDetail, setOpenDetail] = useState<string>();
  const open = expanded ?? running;
  const failed = activities.filter((entry) => entry.status === "failed").length;
  const visible = open ? activities : activities.slice(-COLLAPSED_VISIBLE);
  const hidden = activities.length - visible.length;
  return (
    <section className={`work-log${running ? " is-running" : ""}`} aria-label="Work log">
      <button className="work-log-header" type="button" aria-expanded={open} onClick={() => setExpanded(!open)}>
        <Icon name="chevronRight" size={12} className="work-log-chevron" />
        <span className="work-log-summary">{workSummary(activities)}</span>
        {failed > 0 ? <span className="work-log-failed">{failed} failed</span> : null}
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
          {visible.map((entry) => {
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
                  <span className="work-entry-status">
                    {entry.status === "running" ? (
                      <Icon name="circle" size={11} aria-label="Running" />
                    ) : entry.status === "failed" ? (
                      <Icon name="x" size={12} aria-label="Failed" />
                    ) : (
                      <Icon name="check" size={12} aria-label="Done" />
                    )}
                  </span>
                </button>
                {detailOpen && entry.detail ? <pre className="work-entry-detail">{entry.detail}</pre> : null}
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
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
        <button className="ghost-button" type="button" onClick={() => onOpenDiff()}>
          Open diff
        </button>
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
