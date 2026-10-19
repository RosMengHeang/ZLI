// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { clampPanelWidth } from "./PanelResizer.js";

describe("clampPanelWidth", () => {
  it("keeps the side panel between its minimum and 65% of the window", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    expect(clampPanelWidth(100)).toBe(320);
    expect(clampPanelWidth(500.4)).toBe(500);
    expect(clampPanelWidth(5000)).toBe(936);
  });
});
