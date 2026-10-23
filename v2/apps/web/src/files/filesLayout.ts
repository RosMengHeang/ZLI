import { useCallback, useState } from "react";

const STORAGE_KEY = "zli.files.layout.v1";
export const TREE_MIN_WIDTH = 180;
export const TREE_DEFAULT_WIDTH = 260;
/** The editor keeps at least this much room beside the file list. */
export const EDITOR_MIN_WIDTH = 280;
/** Used before the pane has been measured. */
const TREE_FALLBACK_MAX = 640;

export type FilesLayout = { treeWidth: number; treeHidden: boolean };

export const DEFAULT_FILES_LAYOUT: FilesLayout = { treeWidth: TREE_DEFAULT_WIDTH, treeHidden: false };

export function parseFilesLayout(raw: string | null): FilesLayout {
  if (!raw) return { ...DEFAULT_FILES_LAYOUT };
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return { ...DEFAULT_FILES_LAYOUT };
    const record = value as Record<string, unknown>;
    const width = typeof record.treeWidth === "number" && Number.isFinite(record.treeWidth) ? record.treeWidth : NaN;
    return {
      treeWidth: Number.isNaN(width) ? TREE_DEFAULT_WIDTH : Math.max(TREE_MIN_WIDTH, Math.round(width)),
      treeHidden: record.treeHidden === true,
    };
  } catch {
    return { ...DEFAULT_FILES_LAYOUT };
  }
}

export function maxTreeWidth(paneWidth: number | undefined): number {
  if (!paneWidth) return TREE_FALLBACK_MAX;
  return Math.max(TREE_MIN_WIDTH, Math.floor(paneWidth - EDITOR_MIN_WIDTH));
}

/** Keeps the file list and the editor both usable at the current pane width. */
export function clampTreeWidth(width: number, paneWidth: number | undefined): number {
  return Math.round(Math.min(maxTreeWidth(paneWidth), Math.max(TREE_MIN_WIDTH, width)));
}

function readLayout(): FilesLayout {
  try {
    return parseFilesLayout(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return { ...DEFAULT_FILES_LAYOUT };
  }
}

/** The file list width and whether it is hidden, kept across restarts. */
export function useFilesLayout(): [FilesLayout, (patch: Partial<FilesLayout>) => void] {
  const [layout, setLayout] = useState(readLayout);
  const update = useCallback((patch: Partial<FilesLayout>) => {
    setLayout((current) => {
      const next = { ...current, ...patch };
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Storage can be unavailable; the layout still applies until the window closes.
      }
      return next;
    });
  }, []);
  return [layout, update];
}
