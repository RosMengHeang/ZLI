import { describe, expect, it } from "vitest";

import { clipLog } from "./MobileControlActions.js";

describe("clipLog", () => {
  it("keeps the newest lines, cuts long ones, and says how many older lines it left out", () => {
    const lines = Array.from({ length: 400 }, (_, index) => `${index} ${"x".repeat(200)}`);
    lines.push(`last ${"y".repeat(2_000)}`);
    const log = clipLog(lines);
    expect(log.length).toBeLessThanOrEqual(30_100);
    expect(log.split("\n").at(-1)).toBe(`last ${"y".repeat(495)}…`);
    expect(log.split("\n")[0]).toMatch(/^\(\d+ older lines left out\)$/u);
    expect(clipLog(["a", "b"])).toBe("a\nb");
  });
});
