import { useCallback, useState } from "react";

import { baseName } from "./filePaths.js";

const STORAGE_KEY = "zli.files.viewModes.v1";

export const FILE_VIEW_MODES = ["preview", "code", "split"] as const;
export type FileViewMode = (typeof FILE_VIEW_MODES)[number];
/** File types that can be shown rendered as well as as text. */
export type PreviewKind = "markdown";
export type FileViewModes = Record<PreviewKind, FileViewMode>;

export const DEFAULT_FILE_VIEW_MODES: FileViewModes = { markdown: "preview" };

const MARKDOWN_EXTENSIONS = new Set(["md", "mdx", "markdown", "mdown", "mkd"]);

/** Markdown files and extension-less READMEs can be shown rendered. */
export function isMarkdownPath(path: string): boolean {
  const name = baseName(path).toLowerCase();
  if (name === "readme") return true;
  const dot = name.lastIndexOf(".");
  return dot > 0 && MARKDOWN_EXTENSIONS.has(name.slice(dot + 1));
}

export function previewKind(path: string): PreviewKind | undefined {
  return isMarkdownPath(path) ? "markdown" : undefined;
}

function isViewMode(value: unknown): value is FileViewMode {
  return typeof value === "string" && (FILE_VIEW_MODES as readonly string[]).includes(value);
}

export function parseFileViewModes(raw: string | null): FileViewModes {
  const modes = { ...DEFAULT_FILE_VIEW_MODES };
  if (!raw) return modes;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return modes;
    const markdown = (value as Record<string, unknown>).markdown;
    if (isViewMode(markdown)) modes.markdown = markdown;
  } catch {
    // A damaged entry falls back to the defaults.
  }
  return modes;
}

function readModes(): FileViewModes {
  try {
    return parseFileViewModes(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return { ...DEFAULT_FILE_VIEW_MODES };
  }
}

/** Preview, Code, or Split for each previewable file type, kept across restarts. */
export function useFileViewModes(): [FileViewModes, (kind: PreviewKind, mode: FileViewMode) => void] {
  const [modes, setModes] = useState(readModes);
  const update = useCallback((kind: PreviewKind, mode: FileViewMode) => {
    setModes((current) => {
      if (current[kind] === mode) return current;
      const next = { ...current, [kind]: mode };
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Storage can be unavailable; the choice still applies until the window closes.
      }
      return next;
    });
  }, []);
  return [modes, update];
}
