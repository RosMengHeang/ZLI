import { baseName } from "./filePaths.js";

/** Markdown opens rendered; Code shows the editor. */
export const FILE_VIEW_MODES = ["preview", "code"] as const;
export type FileViewMode = (typeof FILE_VIEW_MODES)[number];
/** File types that can be shown rendered as well as as text. */
export type PreviewKind = "markdown";

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
