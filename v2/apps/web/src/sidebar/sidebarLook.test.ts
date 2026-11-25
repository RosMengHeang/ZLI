import { describe, expect, it } from "vitest";

import { DEFAULT_SIDEBAR_LOOK, parseSidebarLook } from "../settings/appSettings.js";
import { sidebarLookClass, sidebarLookStyle } from "./sidebarLook.js";

describe("sidebar look", () => {
  it("reads back a saved look and falls back for anything unknown", () => {
    expect(parseSidebarLook(undefined)).toEqual(DEFAULT_SIDEBAR_LOOK);
    expect(parseSidebarLook({ background: "neon", layout: "side", density: "tiny", strength: "x" })).toEqual(
      DEFAULT_SIDEBAR_LOOK,
    );
    expect(parseSidebarLook({ background: "tint", color: "#AABBCC", strength: 90, density: "compact" })).toEqual({
      background: "tint",
      color: "#aabbcc",
      strength: 40,
      density: "compact",
    });
    expect(parseSidebarLook({ background: "tint", color: "red", strength: 1 })).toEqual({
      ...DEFAULT_SIDEBAR_LOOK,
      background: "tint",
      strength: 4,
    });
  });

  it("turns the look into classes and a sidebar color", () => {
    expect(sidebarLookClass(DEFAULT_SIDEBAR_LOOK, "classic")).toBe(" is-floating");
    expect(sidebarLookClass(DEFAULT_SIDEBAR_LOOK, "columns")).toBe("");
    expect(sidebarLookClass({ ...DEFAULT_SIDEBAR_LOOK, density: "compact" }, "classic")).toBe(" is-floating is-dense");
    expect(sidebarLookStyle(DEFAULT_SIDEBAR_LOOK)).toBeUndefined();
    expect(sidebarLookStyle({ ...DEFAULT_SIDEBAR_LOOK, background: "surface" })).toEqual({
      "--zli-sidebar": "var(--zli-surface)",
    });
    expect(sidebarLookStyle({ ...DEFAULT_SIDEBAR_LOOK, background: "tint", strength: 20 })).toEqual({
      "--zli-sidebar": "color-mix(in srgb, var(--zli-accent) 20%, var(--zli-sidebar-base))",
    });
    expect(sidebarLookStyle({ ...DEFAULT_SIDEBAR_LOOK, background: "tint", color: "#112233", strength: 8 })).toEqual({
      "--zli-sidebar": "color-mix(in srgb, #112233 8%, var(--zli-sidebar-base))",
    });
  });
});
