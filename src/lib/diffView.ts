export type DiffKind = "meta" | "header" | "hunk" | "add" | "del" | "ctx";

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

export const DIFF_LINE_HEIGHT = 18;
export const DIFF_OVERSCAN = 40;
export const MAX_DIFF_LINES = 8000;

export function classifyDiffLine(line: string): DiffKind {
  if (
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file")
  ) {
    return "meta";
  }
  if (line.startsWith("---") || line.startsWith("+++")) return "header";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

export function parseDiffLines(diff: string): DiffLine[] {
  return diff.replace(/\r\n/g, "\n").split("\n").map((text) => ({
    kind: classifyDiffLine(text),
    text,
  }));
}

export function visibleDiffRange(
  scrollTop: number,
  viewportHeight: number,
  lineCount: number,
  lineHeight = DIFF_LINE_HEIGHT,
  overscan = DIFF_OVERSCAN,
): { start: number; end: number } {
  const start = Math.max(0, Math.floor(scrollTop / lineHeight) - overscan);
  const visible = Math.max(1, Math.ceil(viewportHeight / lineHeight));
  const end = Math.min(lineCount, start + visible + overscan * 2);
  return { start, end };
}
