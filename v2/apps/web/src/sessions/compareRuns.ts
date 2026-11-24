import type {
  ThreadCheckpoint,
  ThreadMessageProjection,
  ThreadUsageRecord,
  TurnCheckpointFile,
} from "@zli-v2/contracts";

import { sumUsage, tokenTotal } from "../usage/usage.js";

/** One file a run changed, summed over the run's turns. */
export type RunFile = {
  path: string;
  oldPath?: string | undefined;
  kind: TurnCheckpointFile["kind"];
  additions: number;
  deletions: number;
  binary: boolean;
  /** The first and last turn that changed the file, so its diff can cover every turn in between. */
  firstCheckpointId: string;
  lastCheckpointId: string;
};

/**
 * The files a run's agent changed, by path. The numbers add up each turn's lines, so a line changed in two turns
 * counts twice; most runs are one turn. Each turn lists at most its first 300 files.
 */
export function runFiles(
  checkpoints: readonly ThreadCheckpoint[] | undefined,
  threadId: string | undefined,
): RunFile[] {
  if (!threadId || !checkpoints) return [];
  const byPath = new Map<string, RunFile>();
  for (const checkpoint of checkpoints) {
    if (checkpoint.threadId !== threadId) continue;
    for (const file of checkpoint.files) {
      const known = byPath.get(file.path) ?? (file.oldPath ? byPath.get(file.oldPath) : undefined);
      if (!known) {
        byPath.set(file.path, {
          path: file.path,
          ...(file.oldPath ? { oldPath: file.oldPath } : {}),
          kind: file.kind,
          additions: file.additions,
          deletions: file.deletions,
          binary: file.binary,
          firstCheckpointId: checkpoint.checkpointId,
          lastCheckpointId: checkpoint.checkpointId,
        });
        continue;
      }
      if (known.path !== file.path) {
        byPath.delete(known.path);
        known.oldPath = known.oldPath ?? known.path;
        known.path = file.path;
      }
      known.additions += file.additions;
      known.deletions += file.deletions;
      known.binary ||= file.binary;
      // A file the run added stays added; a file it deleted last is deleted.
      if (file.kind === "deleted") known.kind = "deleted";
      else if (known.kind === "deleted") known.kind = "modified";
      known.lastCheckpointId = checkpoint.checkpointId;
      byPath.set(file.path, known);
    }
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export type FileMatrixRow = {
  path: string;
  /** One cell per run, in run order; empty where the run left the file alone. */
  cells: (RunFile | undefined)[];
  /** How many runs changed this file. */
  touchedBy: number;
};

/** Every file any run changed, with what each run did to it. Sorted by path. */
export function fileMatrix(runs: readonly (readonly RunFile[])[]): FileMatrixRow[] {
  const paths = new Set(runs.flatMap((files) => files.map((file) => file.path)));
  const lookups = runs.map((files) => new Map(files.map((file) => [file.path, file])));
  return [...paths]
    .sort((left, right) => left.localeCompare(right))
    .map((path) => {
      const cells = lookups.map((lookup) => lookup.get(path));
      return { path, cells, touchedBy: cells.filter(Boolean).length };
    });
}

/** The agent's last reply in the run, which is usually its summary of what it did. */
export function finalReply(
  messages: readonly ThreadMessageProjection[] | undefined,
  threadId: string | undefined,
): string | undefined {
  if (!threadId || !messages) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.threadId === threadId && message.role === "assistant" && message.text.trim()) return message.text;
  }
  return undefined;
}

/** Input and output tokens the run's turns reported, or nothing when none reported any. */
export function runTokens(
  usage: readonly ThreadUsageRecord[] | undefined,
  threadId: string | undefined,
): number | undefined {
  if (!threadId || !usage) return undefined;
  const records = usage.filter((record) => record.threadId === threadId);
  if (records.length === 0) return undefined;
  const total = tokenTotal(sumUsage(records));
  return total > 0 ? total : undefined;
}

/** For each file, the run whose version to bring into the kept run. Files missing here keep the kept run's version. */
export type PartPicks = ReadonlyMap<string, number>;

export type PartsFromRun = { runIndex: number; paths: string[] };

/** The files to copy into the kept run, grouped by the run they come from, in run order. */
export function partsToBring(picks: PartPicks, keptIndex: number): PartsFromRun[] {
  const byRun = new Map<number, string[]>();
  for (const [path, runIndex] of picks) {
    if (runIndex === keptIndex) continue;
    byRun.set(runIndex, [...(byRun.get(runIndex) ?? []), path]);
  }
  return [...byRun.entries()]
    .sort(([left], [right]) => left - right)
    .map(([runIndex, paths]) => ({ runIndex, paths: paths.sort((left, right) => left.localeCompare(right)) }));
}
