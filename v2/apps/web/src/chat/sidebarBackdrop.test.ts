import { describe, expect, it } from "vitest";

import { sidebarDotsField, sidebarRampField, sidebarSoftField } from "./backdrop.js";

describe("the sidebar's own backgrounds", () => {
  it("keeps the top left, where the names sit, clear", () => {
    for (const field of [sidebarSoftField, sidebarDotsField]) expect(field(0.1, 0.1)).toBe(0);
    expect(sidebarRampField(0.2)).toBe(0);
  });

  it("gathers at the bottom and along the edge that meets the chat", () => {
    expect(sidebarSoftField(0.5, 1)).toBeGreaterThan(sidebarSoftField(0.5, 0.7));
    expect(sidebarSoftField(1, 0.3)).toBeGreaterThan(0);
    expect(sidebarDotsField(1, 1)).toBeGreaterThan(sidebarDotsField(1, 0.2));
    expect(sidebarDotsField(0.4, 1)).toBe(0);
    expect(sidebarRampField(1)).toBe(1);
    expect(sidebarRampField(0.775)).toBeCloseTo(0.5);
  });
});
