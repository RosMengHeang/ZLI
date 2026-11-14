import { describe, expect, it } from "vitest";

import { usageLimitCopy } from "./UsageLimitNote.js";

const resetsAt = "2026-11-13T15:00:00.000Z";
const reset = Date.parse(resetsAt);

describe("usageLimitCopy", () => {
  it("offers to resume at reset, then to cancel once it is set", () => {
    const before = reset - 2 * 3_600_000 - 10 * 60_000;
    expect(usageLimitCopy({ resetsAt }, before)).toMatchObject({ action: "resume" });
    expect(usageLimitCopy({ resetsAt }, before).detail).toMatch(/^Resets at .+, in 2h 10m\.$/);
    expect(usageLimitCopy({ resetsAt, autoResume: true }, before)).toMatchObject({ action: "cancel" });
    expect(usageLimitCopy({ resetsAt, autoResume: true }, before).detail).toMatch(/^Continues by itself at /);
  });

  it("offers to continue after the reset, and says when no reset time came", () => {
    expect(usageLimitCopy({ resetsAt }, reset + 1)).toEqual({ detail: "Your limit has reset.", action: "continue" });
    expect(usageLimitCopy({ resetsAt, autoResume: true }, reset + 1).action).toBeUndefined();
    expect(usageLimitCopy({}, reset)).toEqual({
      detail: "The agent didn't say when it resets. Send a message to try again.",
    });
  });
});
