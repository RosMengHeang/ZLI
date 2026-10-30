import { describe, expect, it } from "vitest";

import { reasoningBars } from "./ReasoningMeter.js";

describe("reasoningBars", () => {
  it("fills the meter up to the level", () => {
    expect(["off", "minimal", "low", "medium", "high", "xhigh", "Max"].map(reasoningBars)).toEqual([
      0, 1, 1, 2, 3, 3, 3,
    ]);
  });

  it("reads no level, or one it does not know, as the middle", () => {
    expect(reasoningBars(undefined)).toBe(2);
    expect(reasoningBars("turbo")).toBe(2);
  });
});
