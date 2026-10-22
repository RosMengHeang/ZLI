import type { ThreadActivityProjection } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { groupActivities, groupLabel } from "./WorkLog.js";

const activity = (id: string, kind: ThreadActivityProjection["kind"]) =>
  ({
    activityId: id,
    threadId: "00000000-0000-4000-8000-000000000001",
    turnId: "t1",
    kind,
    title: id,
    status: "completed",
  }) as ThreadActivityProjection;

describe("groupActivities", () => {
  it("folds consecutive reads and searches but keeps edits and commands on their own rows", () => {
    const rows = groupActivities([
      activity("r1", "file-read"),
      activity("r2", "file-read"),
      activity("r3", "file-read"),
      activity("e1", "file-edit"),
      activity("s1", "search"),
      activity("s2", "search"),
      activity("r4", "file-read"),
      activity("c1", "command"),
      activity("c2", "command"),
    ]);
    expect(rows.map((row) => (row.kind === "group" ? row.entries.map((entry) => entry.activityId) : row.key))).toEqual([
      ["r1", "r2", "r3"],
      "e1",
      ["s1", "s2"],
      "r4",
      "c1",
      "c2",
    ]);
  });

  it("does not merge reads and searches into one group", () => {
    const rows = groupActivities([activity("r1", "file-read"), activity("s1", "search"), activity("w1", "web")]);
    expect(rows.every((row) => row.kind === "entry")).toBe(true);
  });

  it("names each group in plain words", () => {
    expect(groupLabel("file-read", 3)).toBe("Read 3 files");
    expect(groupLabel("search", 2)).toBe("2 searches");
    expect(groupLabel("web", 4)).toBe("4 web lookups");
  });
});
