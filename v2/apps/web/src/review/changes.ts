import type { ReviewFileProjection } from "@zli-v2/contracts";

export type StageState = "staged" | "unstaged" | "partial" | "committed";

/** Committed means the file differs from the base only through commits, so there is nothing to stage. */
export function stageStateOf(file: ReviewFileProjection): StageState {
  // Projections saved before staging existed lack `unstaged`; treat their files as unstaged until a refresh.
  const unstaged = file.unstaged ?? !file.staged;
  return file.staged && unstaged ? "partial" : file.staged ? "staged" : unstaged ? "unstaged" : "committed";
}

/** Lines added and removed across the files, as the Changes header shows them. */
export function changeTotals(files: readonly ReviewFileProjection[]): { additions: number; deletions: number } {
  return files.reduce(
    (sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }),
    { additions: 0, deletions: 0 },
  );
}
