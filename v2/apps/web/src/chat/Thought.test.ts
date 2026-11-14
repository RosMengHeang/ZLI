import type { ThreadActivityProjection } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { durationLabel, elapsedLabel, latestThoughtLine, stepDuration, thoughtLabel } from "./Thought.js";
import { groupDuration, groupSteps, stepState } from "./WorkLog.js";

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, 0) + seconds * 1_000).toISOString();

const activity = (id: string, extra: Partial<ThreadActivityProjection> = {}) =>
  ({
    activityId: id,
    threadId: "00000000-0000-4000-8000-000000000001",
    turnId: "t1",
    kind: "command",
    title: id,
    status: "completed",
    ...extra,
  }) as ThreadActivityProjection;

describe("step durations", () => {
  it("measures a finished step and hides anything under a second", () => {
    expect(stepDuration({ startedAt: at(0), completedAt: at(14) })).toBe(14_000);
    expect(stepDuration({ startedAt: at(0) })).toBeUndefined();
    expect(stepDuration({})).toBeUndefined();
    expect(durationLabel(14_000)).toBe("14s");
    expect(durationLabel(65_000)).toBe("1m 05s");
    expect(durationLabel(999)).toBeUndefined();
    expect(durationLabel(undefined)).toBeUndefined();
    expect(elapsedLabel(3_725_000)).toBe("1h 02m");
  });

  it("spans a run of lookups from the first start to the last end, and not while one runs", () => {
    const entries = [
      activity("r1", { kind: "file-read", startedAt: at(0), completedAt: at(2) }),
      activity("r2", { kind: "file-read", startedAt: at(1), completedAt: at(9) }),
    ];
    expect(groupDuration(entries)).toBe(9_000);
    expect(groupDuration([...entries, activity("r3", { kind: "file-read", startedAt: at(3) })])).toBeUndefined();
  });

  it("says how long the agent thought, or a few seconds when it was quick or the times are missing", () => {
    expect(thoughtLabel({ startedAt: at(0), completedAt: at(12) })).toBe("Thought for 12s");
    expect(thoughtLabel({ startedAt: at(0), completedAt: at(65) })).toBe("Thought for 1m 05s");
    expect(thoughtLabel({ startedAt: at(0), completedAt: at(1) })).toBe("Thought for a few seconds");
    expect(thoughtLabel({})).toBe("Thought for a few seconds");
  });
});

describe("latestThoughtLine", () => {
  it("reads the last line with words, without its Markdown marks", () => {
    expect(latestThoughtLine("**Planning**\n\nRead the `cache` helpers first.\n\n")).toBe(
      "Read the cache helpers first.",
    );
    expect(latestThoughtLine("## Checking the routes")).toBe("Checking the routes");
    expect(latestThoughtLine("- one\n- two")).toBe("two");
    expect(latestThoughtLine("  \n ")).toBeUndefined();
    expect(latestThoughtLine(undefined)).toBeUndefined();
  });
});

describe("thinking among the steps", () => {
  it("gives thinking a row of its own that splits a run of lookups", () => {
    const rows = groupSteps([
      activity("r1", { kind: "file-read" }),
      activity("think", { kind: "reasoning", text: "Hmm" }),
      activity("r2", { kind: "file-read" }),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["explore", "thought", "explore"]);
  });

  it("reads a refused call as denied and any other failure as failed", () => {
    expect(stepState(activity("a", { status: "failed", detail: "Rejected by user" }))).toBe("denied");
    expect(stepState(activity("b", { status: "failed", detail: "exit code 1" }))).toBe("failed");
    expect(stepState(activity("d", { status: "failed", detail: "cat: /root/x: Permission denied" }))).toBe("failed");
    expect(stepState(activity("c", { status: "running" }))).toBe("running");
  });
});
