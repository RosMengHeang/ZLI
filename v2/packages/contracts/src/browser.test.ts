import { describe, expect, it } from "vitest";

import {
  BROWSER_DEVICE_PRESETS,
  BrowserRevealEvent,
  BrowserSetViewportInput,
  BrowserTabProjection,
  BrowserViewport,
  browserViewportForPreset,
} from "./index.js";

const browserTabId = "70000000-0000-4000-8000-000000000001";
const worktreeId = "60000000-0000-4000-8000-000000000001";
const profileId = "00000000-0000-4000-8000-000000000002";

describe("browser contracts", () => {
  it("accepts device viewports inside the supported range and rejects the rest", () => {
    expect(BrowserViewport.parse({ width: 393, height: 852, deviceScaleFactor: 3, mobile: true })).toEqual({
      width: 393,
      height: 852,
      deviceScaleFactor: 3,
      mobile: true,
    });
    expect(BrowserViewport.safeParse({ width: 199, height: 852, mobile: true }).success).toBe(false);
    expect(BrowserViewport.safeParse({ width: 393, height: 4001, mobile: true }).success).toBe(false);
    expect(BrowserViewport.safeParse({ width: 393.5, height: 852, mobile: true }).success).toBe(false);
    expect(BrowserViewport.safeParse({ width: 393, height: 852, deviceScaleFactor: 5, mobile: true }).success).toBe(
      false,
    );
    expect(BrowserViewport.safeParse({ width: 393, height: 852 }).success).toBe(false);
    expect(BrowserViewport.safeParse({ preset: "x".repeat(41), width: 393, height: 852, mobile: true }).success).toBe(
      false,
    );
  });

  it("allows clearing a viewport and keeps projections without one valid", () => {
    expect(BrowserSetViewportInput.parse({ browserTabId, viewport: null }).viewport).toBeNull();
    const projection = {
      browserTabId,
      profileId,
      worktreeId,
      url: "about:blank",
      title: "",
      active: false,
      status: "idle",
    };
    expect(BrowserTabProjection.parse(projection)).not.toHaveProperty("viewport");
    const viewport = browserViewportForPreset("iphone-15");
    expect(BrowserTabProjection.parse({ ...projection, viewport }).viewport).toEqual({
      preset: "iphone-15",
      width: 393,
      height: 852,
      deviceScaleFactor: 3,
      mobile: true,
    });
  });

  it("ships presets that satisfy the viewport schema", () => {
    expect(BROWSER_DEVICE_PRESETS.map((preset) => preset.id)).toEqual([
      "iphone-15",
      "pixel-8",
      "ipad-air",
      "laptop",
      "desktop",
    ]);
    for (const preset of BROWSER_DEVICE_PRESETS) {
      expect(BrowserViewport.safeParse(browserViewportForPreset(preset.id)).success).toBe(true);
      expect(BrowserViewport.parse(preset.viewport)).toEqual(browserViewportForPreset(preset.id));
    }
    expect(browserViewportForPreset("watch")).toBeUndefined();
  });

  it("validates reveal events", () => {
    expect(BrowserRevealEvent.parse({ browserTabId, worktreeId })).toEqual({ browserTabId, worktreeId });
    expect(BrowserRevealEvent.safeParse({ browserTabId }).success).toBe(false);
  });
});
