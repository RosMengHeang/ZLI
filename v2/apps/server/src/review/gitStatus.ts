export type StatusEntry = { xy: string; path: string; oldPath?: string };

/**
 * Parses `git status --porcelain=v1 -z`: `XY path\0`, and for a rename or copy `XY new\0old\0`. Without -z Git
 * quotes names with spaces or unusual characters, which would not match the paths other commands print.
 */
export function parseStatusZ(stdout: string): StatusEntry[] {
  const fields = stdout.split("\0");
  const entries: StatusEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? "";
    if (field.length < 4) continue;
    const entry: StatusEntry = { xy: field.slice(0, 2), path: field.slice(3) };
    if (entry.xy.includes("R") || entry.xy.includes("C")) {
      const oldPath = fields[index + 1];
      index += 1;
      if (oldPath) entry.oldPath = oldPath;
    }
    entries.push(entry);
  }
  return entries;
}

export function isConflict(xy: string): boolean {
  return xy.includes("U") || xy === "AA" || xy === "DD";
}
