import type { ThreadActivityProjection } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { liveStatus, liveStepLabel, runningStep } from "./liveStatus.js";

const step = (extra: Partial<ThreadActivityProjection>) =>
  ({
    activityId: "a",
    threadId: "t",
    kind: "command",
    title: "npm test",
    status: "completed",
    ...extra,
  }) as ThreadActivityProjection;

describe("live status", () => {
  it("reads the latest line of thought while the agent thinks", () => {
    const thinking = step({
      kind: "reasoning",
      title: "Thinking",
      status: "running",
      text: "**Plan**\n\n- Read the `cache`",
    });
    expect(liveStatus([step({}), thinking])).toBe("Read the cache");
    expect(liveStepLabel(step({ kind: "reasoning", title: "Thinking", status: "running" }))).toBe("Thinking");
  });

  it("names the running step, and says Working when nothing runs", () => {
    expect(liveStatus([step({ status: "running", title: "npm run build" }), step({ title: "Read a.ts" })])).toBe(
      "npm run build",
    );
    expect(liveStatus([step({})])).toBe("Working");
    expect(liveStatus([])).toBe("Working");
  });

  it("finds the latest step still running", () => {
    const first = step({ activityId: "1", status: "running" });
    const second = step({ activityId: "2", status: "running" });
    expect(runningStep([first, second, step({ activityId: "3" })])).toBe(second);
    expect(runningStep([step({})])).toBeUndefined();
  });
});
