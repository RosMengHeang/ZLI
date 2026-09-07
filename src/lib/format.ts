export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

export function displayPath(path: string, max = 56): string {
  if (path.length <= max) return path;
  return `…${path.slice(-(max - 1))}`;
}

export function formatPlusMinus(additions: number | null | undefined, deletions: number | null | undefined): string {
  if (additions == null && deletions == null) return "";
  const add = additions ?? 0;
  const del = deletions ?? 0;
  return `+${add} −${del}`;
}

export function fileStatusLabel(status: string): string {
  switch (status) {
    case "added":
      return "A";
    case "modified":
      return "M";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "untracked":
      return "U";
    case "typeChanged":
      return "T";
    case "unmerged":
      return "!";
    default:
      return "?";
  }
}
