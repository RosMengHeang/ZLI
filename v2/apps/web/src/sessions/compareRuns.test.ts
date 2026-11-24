import type { ThreadCheckpoint, ThreadMessageProjection, ThreadUsageRecord } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { fileMatrix, finalReply, partsToBring, runFiles, runTokens } from "./compareRuns.js";

function checkpoint(
  checkpointId: string,
  threadId: string,
  files: { path: string; additions: number; deletions: number; kind?: string; oldPath?: string }[],
): ThreadCheckpoint {
  return {
    checkpointId,
    threadId,
    worktreeId: "w",
    turnId: checkpointId,
    startTree: "a".repeat(40),
    endTree: "b".repeat(40),
    files: files.map((file) => ({ kind: "modified", binary: false, ...file })),
    fileCount: files.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  } as unknown as ThreadCheckpoint;
}

describe("runFiles", () => {
  it("adds up a file over the run's turns and remembers the first and last turn", () => {
    const files = runFiles(
      [
        checkpoint("c1", "t1", [
          { path: "src/b.ts", additions: 3, deletions: 1, kind: "added" },
          { path: "src/a.ts", additions: 2, deletions: 0 },
        ]),
        checkpoint("other", "t2", [{ path: "src/a.ts", additions: 50, deletions: 50 }]),
        checkpoint("c2", "t1", [{ path: "src/b.ts", additions: 1, deletions: 2 }]),
      ],
      "t1",
    );
    expect(files).toEqual([
      expect.objectContaining({
        path: "src/a.ts",
        additions: 2,
        deletions: 0,
        firstCheckpointId: "c1",
        lastCheckpointId: "c1",
      }),
      expect.objectContaining({
        path: "src/b.ts",
        kind: "added",
        additions: 4,
        deletions: 3,
        firstCheckpointId: "c1",
        lastCheckpointId: "c2",
      }),
    ]);
  });

  it("follows a rename and marks a file deleted when the last turn deleted it", () => {
    const files = runFiles(
      [
        checkpoint("c1", "t1", [
          { path: "old.ts", additions: 1, deletions: 0 },
          { path: "gone.ts", additions: 1, deletions: 0 },
        ]),
        checkpoint("c2", "t1", [
          { path: "new.ts", oldPath: "old.ts", additions: 0, deletions: 0, kind: "renamed" },
          { path: "gone.ts", additions: 0, deletions: 2, kind: "deleted" },
        ]),
      ],
      "t1",
    );
    expect(files.map((file) => [file.path, file.oldPath, file.kind])).toEqual([
      ["gone.ts", undefined, "deleted"],
      ["new.ts", "old.ts", "modified"],
    ]);
  });

  it("is empty without a thread", () => {
    expect(runFiles([checkpoint("c1", "t1", [{ path: "a", additions: 1, deletions: 0 }])], undefined)).toEqual([]);
  });
});

describe("fileMatrix", () => {
  it("lists every file once, with a cell per run and how many runs touched it", () => {
    const one = runFiles([checkpoint("c1", "t1", [{ path: "b.ts", additions: 1, deletions: 0 }])], "t1");
    const two = runFiles(
      [
        checkpoint("c2", "t2", [
          { path: "a.ts", additions: 5, deletions: 5 },
          { path: "b.ts", additions: 2, deletions: 1 },
        ]),
      ],
      "t2",
    );
    const rows = fileMatrix([one, two, []]);
    expect(rows.map((row) => [row.path, row.touchedBy])).toEqual([
      ["a.ts", 1],
      ["b.ts", 2],
    ]);
    expect(rows[0]?.cells.map((cell) => cell?.additions)).toEqual([undefined, 5, undefined]);
    expect(rows[1]?.cells.map((cell) => cell?.additions)).toEqual([1, 2, undefined]);
  });
});

describe("finalReply and runTokens", () => {
  it("takes the run's last non-empty assistant message", () => {
    const messages = [
      { messageId: "1", threadId: "t1", role: "user", text: "Do it" },
      { messageId: "2", threadId: "t1", role: "assistant", text: "First" },
      { messageId: "3", threadId: "t2", role: "assistant", text: "Other run" },
      { messageId: "4", threadId: "t1", role: "assistant", text: "Done. Changed two files." },
      { messageId: "5", threadId: "t1", role: "assistant", text: "  " },
    ] as ThreadMessageProjection[];
    expect(finalReply(messages, "t1")).toBe("Done. Changed two files.");
    expect(finalReply(messages, "t3")).toBeUndefined();
  });

  it("sums input and output tokens of the run's turns, or nothing when none were reported", () => {
    const usage = [
      { threadId: "t1", usage: { inputTokens: 1000, outputTokens: 200 } },
      { threadId: "t1", usage: { inputTokens: 500, outputTokens: 100 } },
      { threadId: "t2", usage: { inputTokens: 9 } },
    ] as unknown as ThreadUsageRecord[];
    expect(runTokens(usage, "t1")).toBe(1800);
    expect(runTokens(usage, "t3")).toBeUndefined();
    expect(runTokens([{ threadId: "t4", usage: {} }] as unknown as ThreadUsageRecord[], "t4")).toBeUndefined();
  });
});

describe("partsToBring", () => {
  it("groups the picked files by the run they come from and skips the kept run's own", () => {
    const picks = new Map([
      ["z.ts", 3],
      ["a.ts", 3],
      ["b.ts", 1],
      ["c.ts", 2],
    ]);
    expect(partsToBring(picks, 2)).toEqual([
      { runIndex: 1, paths: ["b.ts"] },
      { runIndex: 3, paths: ["a.ts", "z.ts"] },
    ]);
    expect(partsToBring(new Map(), 1)).toEqual([]);
  });
});
