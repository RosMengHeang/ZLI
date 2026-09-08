export function changedFileLabel({ status, path }: { status: string; path: string }): string {
  const labels: Record<string, string> = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", "?": "Untracked", modified: "Modified", added: "Added", deleted: "Deleted", renamed: "Renamed", untracked: "Untracked", unmerged: "Conflict" };
  return `${labels[status] ?? "Changed"}: ${path}`;
}
