import type { ThreadActivityProjection } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { elapsedLabel, exploreCounts, groupSteps, liveStepLabel } from "./WorkLog.js";

const activity = (id: string, kind: ThreadActivityProjection["kind"], extra: Partial<ThreadActivityProjection> = {}) =>
  ({
    activityId: id,
    threadId: "00000000-0000-4000-8000-000000000001",
    turnId: "t1",
    kind,
    title: id,
    status: "completed",
    ...extra,
  }) as ThreadActivityProjection;

describe("groupSteps", () => {
  it("folds a run of reads, searches, and lookups into one step and keeps edits and commands apart", () => {
    const rows = groupSteps([
      activity("r1", "file-read"),
      activity("s1", "search"),
      activity("w1", "web"),
      activity("e1", "file-edit"),
      activity("r2", "file-read"),
      activity("c1", "command"),
      activity("c2", "command"),
    ]);
    expect(
      rows.map((row) => (row.kind === "explore" ? row.entries.map((entry) => entry.activityId) : row.key)),
    ).toEqual([["r1", "s1", "w1"], "e1", ["r2"], "c1", "c2"]);
  });
});

describe("step labels", () => {
  it("counts files once however often they were read", () => {
    expect(
      exploreCounts([
        activity("r1", "file-read", { files: ["a.ts"] }),
        activity("r2", "file-read", { files: ["a.ts"] }),
        activity("r3", "file-read", { files: ["b.ts"] }),
        activity("s1", "search"),
      ]),
    ).toBe("2 files, 1 search");
    expect(exploreCounts([activity("w1", "web"), activity("w2", "web")])).toBe("2 web pages");
  });

  it("says what is running in a few words", () => {
    expect(liveStepLabel(activity("r", "file-read", { files: ["src/app/routes.ts"] }))).toBe("Reading routes.ts");
    expect(liveStepLabel(activity("e", "file-edit", { files: ["C:\\repo\\notes.md"] }))).toBe("Editing notes.md");
    expect(liveStepLabel(activity("c", "command", { title: "npm test" }))).toBe("Running npm test");
    expect(liveStepLabel(activity("s", "search", { title: "Search TODO" }))).toBe("Searching for TODO");
    expect(liveStepLabel(activity("w", "web", { title: "Fetch https://example.com" }))).toBe(
      "Opening https://example.com",
    );
  });

  it("formats elapsed time", () => {
    expect(elapsedLabel(8_400)).toBe("8s");
    expect(elapsedLabel(65_000)).toBe("1m 05s");
    expect(elapsedLabel(3_720_000)).toBe("1h 02m");
  });
});
