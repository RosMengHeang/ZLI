// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import { clampSidebarWidth, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from "./SidebarResizer.js";

const width = window.innerWidth;
afterEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
});

describe("clampSidebarWidth", () => {
  it("keeps the sidebar between its own limits", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1600 });
    expect(clampSidebarWidth(80)).toBe(MIN_SIDEBAR_WIDTH);
    expect(clampSidebarWidth(300.4)).toBe(300);
    expect(clampSidebarWidth(900)).toBe(MAX_SIDEBAR_WIDTH);
  });

  it("never takes more than 40% of a small window", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    expect(clampSidebarWidth(400)).toBe(320);
  });
});
