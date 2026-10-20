import type { FileChangeStatus, FileListEntry } from "@zli-v2/contracts";
import { type KeyboardEvent, useEffect, useMemo, useRef } from "react";

import { Icon } from "../ui/Icon.js";
import { buildFileTree, visibleTreeRows } from "./fileTree.js";

/** Rendering every row of a fully expanded monorepo would stall the panel. */
const MAX_ROWS = 4_000;

export const statusLetter: Record<FileChangeStatus, string> = {
  modified: "M",
  added: "A",
  untracked: "U",
  deleted: "D",
  renamed: "R",
  conflicted: "!",
};

export const statusLabel: Record<FileChangeStatus, string> = {
  modified: "Modified",
  added: "Added",
  untracked: "New, not tracked by Git",
  deleted: "Deleted",
  renamed: "Renamed",
  conflicted: "Merge conflict",
};

export function FileStatusMark({ status }: { status: FileChangeStatus | undefined }) {
  if (!status) return null;
  return (
    <span className={`file-status file-status-${status}`} title={statusLabel[status]}>
      {statusLetter[status]}
    </span>
  );
}

function findRow(container: HTMLElement, path: string): HTMLElement | undefined {
  for (const row of container.querySelectorAll<HTMLElement>("[data-tree-row]"))
    if (row.dataset.path === path) return row;
  return undefined;
}

export function FileTreeView({
  entries,
  expanded,
  selectedPath,
  revealKey,
  onToggle,
  onOpen,
}: {
  entries: readonly FileListEntry[];
  expanded: ReadonlySet<string>;
  selectedPath: string | undefined;
  /** Changes when the selected file should scroll into view. */
  revealKey: number;
  onToggle(path: string): void;
  onOpen(path: string): void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const tree = useMemo(() => buildFileTree(entries), [entries]);
  const rows = useMemo(() => visibleTreeRows(tree, expanded), [tree, expanded]);
  const shown = rows.length > MAX_ROWS ? rows.slice(0, MAX_ROWS) : rows;

  // biome-ignore lint/correctness/useExhaustiveDependencies: only a reveal request should scroll.
  useEffect(() => {
    if (!selectedPath) return;
    const row = listRef.current ? findRow(listRef.current, selectedPath) : undefined;
    row?.scrollIntoView?.({ block: "nearest" });
  }, [revealKey]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>("[data-tree-row]");
    if (!row || !listRef.current) return;
    const all = [...listRef.current.querySelectorAll<HTMLElement>("[data-tree-row]")];
    const index = all.indexOf(row);
    const path = row.dataset.path ?? "";
    const isDirectory = row.dataset.kind === "directory";
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      all[index + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
    } else if (event.key === "ArrowRight" && isDirectory) {
      event.preventDefault();
      if (!expanded.has(path)) onToggle(path);
      else all[index + 1]?.focus();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (isDirectory && expanded.has(path)) onToggle(path);
      else {
        const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        if (parent) findRow(listRef.current, parent)?.focus();
      }
    }
  };

  if (entries.length === 0) return <p className="files-hint">No files to show.</p>;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move focus between the row buttons inside.
    <div className="file-tree" ref={listRef} onKeyDown={onKeyDown}>
      {shown.map((row) =>
        row.kind === "directory" ? (
          <button
            className="file-row is-directory"
            type="button"
            key={`d:${row.path}`}
            data-tree-row=""
            data-kind="directory"
            data-path={row.path}
            aria-expanded={row.expanded}
            style={{ paddingLeft: 6 + row.depth * 12 }}
            title={row.path}
            onClick={() => onToggle(row.path)}
          >
            <Icon name="chevronRight" size={12} className={`file-row-chevron${row.expanded ? " is-open" : ""}`} />
            <Icon name={row.expanded ? "folderOpen" : "folder"} size={13} className="file-row-icon" />
            <span className="file-row-name">{row.name}</span>
            {row.changed > 0 ? (
              <span
                className="file-row-changed"
                role="img"
                title={`${row.changed} changed`}
                aria-label={`${row.changed} changed`}
              />
            ) : null}
          </button>
        ) : (
          <button
            className={`file-row${row.path === selectedPath ? " is-selected" : ""}${row.status === "deleted" ? " is-deleted" : ""}`}
            type="button"
            key={`f:${row.path}`}
            data-tree-row=""
            data-kind="file"
            data-path={row.path}
            aria-current={row.path === selectedPath ? "true" : undefined}
            style={{ paddingLeft: 6 + row.depth * 12 + 16 }}
            title={row.path}
            onClick={() => onOpen(row.path)}
          >
            <Icon name="file" size={13} className="file-row-icon" />
            <span className="file-row-name">{row.name}</span>
            <FileStatusMark status={row.status} />
          </button>
        ),
      )}
      {rows.length > MAX_ROWS ? (
        <p className="files-hint">
          Showing the first {MAX_ROWS.toLocaleString()} rows. Collapse folders or use Go to file (Ctrl P).
        </p>
      ) : null}
    </div>
  );
}
