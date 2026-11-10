import { describe, expect, it } from "vitest";

import { labelPosition } from "./InspectOverlay.js";

const viewport = { width: 1440, height: 900 };
const card = { width: 240, height: 110 };

describe("inspect label", () => {
  it("sits under a small element", () => {
    expect(labelPosition({ left: 700, top: 500, bottom: 532 }, card.width, card.height, viewport)).toEqual({
      left: 700,
      top: 540,
    });
  });

  it("moves above an element near the bottom of the window", () => {
    expect(labelPosition({ left: 40, top: 840, bottom: 880 }, card.width, card.height, viewport)).toEqual({
      left: 40,
      top: 722,
    });
  });

  it("goes inside an element that fills the window, instead of running off the top", () => {
    const position = labelPosition({ left: 272, top: 92, bottom: 888 }, card.width, card.height, viewport);
    expect(position).toEqual({ left: 280, top: 100 });
    expect(position.top).toBeGreaterThanOrEqual(8);
  });

  it("stays inside the window at the right edge", () => {
    expect(labelPosition({ left: 1400, top: 100, bottom: 120 }, card.width, card.height, viewport).left).toBe(1192);
  });
});
