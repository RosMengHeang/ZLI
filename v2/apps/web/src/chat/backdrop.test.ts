import { describe, expect, it } from "vitest";

import { parseAppSettings } from "../settings/appSettings.js";
import {
  backdropField,
  clampIntensity,
  DEFAULT_BACKDROP_INTENSITY,
  dotsField,
  isBackdropStyle,
  softField,
} from "./backdrop.js";

describe("chat background", () => {
  it("is strong in the corners and quiet in the middle of the reading column", () => {
    expect(backdropField(0.02, 0.02)).toBeGreaterThan(0.4);
    expect(backdropField(0.98, 0.98)).toBeGreaterThan(0.4);
    expect(backdropField(0.5, 0.5)).toBeLessThan(0.15);
  });

  it("washes the bottom edge evenly, with no bright spot, and stays out of the reading column", () => {
    expect(softField(0.5, 1)).toBeGreaterThan(0.9);
    expect(softField(0.05, 1)).toBeCloseTo(softField(0.95, 1), 1);
    expect(softField(0.5, 0.5)).toBe(0);
    expect(softField(0.5, 0.05)).toBeLessThan(0.02);
  });

  it("raises the dots from the bottom middle and keeps them out of the top half", () => {
    expect(dotsField(0.5, 1)).toBeGreaterThan(0.9);
    expect(dotsField(0.05, 1)).toBeLessThan(dotsField(0.5, 1));
    expect(dotsField(0.5, 0.4)).toBe(0);
  });

  it("stays between 0 and 1 everywhere", () => {
    for (let x = 0; x <= 1; x += 0.05) {
      for (let y = 0; y <= 1; y += 0.05) {
        const value = backdropField(x, y);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it("knows its styles and keeps strength in range", () => {
    expect(isBackdropStyle("aurora")).toBe(true);
    expect(isBackdropStyle("plaid")).toBe(false);
    expect(clampIntensity(140)).toBe(100);
    expect(clampIntensity(-3)).toBe(0);
    expect(clampIntensity("loud")).toBe(DEFAULT_BACKDROP_INTENSITY);
  });

  it("is on by default as the soft look, and saved choices survive a reload", () => {
    expect(parseAppSettings(null).chatBackdrop).toEqual({
      style: "glow",
      intensity: DEFAULT_BACKDROP_INTENSITY,
      imageEffect: "photo",
    });
    expect(
      parseAppSettings(JSON.stringify({ chatBackdrop: { style: "halftone", intensity: 35 } })).chatBackdrop,
    ).toEqual({ style: "halftone", intensity: 35, imageEffect: "photo" });
    expect(parseAppSettings(JSON.stringify({ chatBackdrop: { style: "neon", intensity: 900 } })).chatBackdrop).toEqual({
      style: "glow",
      intensity: 100,
      imageEffect: "photo",
    });
  });
});
