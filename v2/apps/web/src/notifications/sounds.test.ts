import { describe, expect, it } from "vitest";

import { isNotificationTone, NOTIFICATION_TONES, TONE_NOTES } from "./sounds.js";

describe("notification sounds", () => {
  it("draws every built-in sound; a custom one is a file", () => {
    for (const { value } of NOTIFICATION_TONES) {
      if (value === "custom") expect(value in TONE_NOTES).toBe(false);
      else expect(TONE_NOTES[value].length).toBeGreaterThan(0);
    }
  });

  it("knows the same sounds the desktop app saves", () => {
    expect(NOTIFICATION_TONES.map((tone) => tone.value)).toEqual(["chime", "ping", "pop", "bell", "soft", "custom"]);
    expect(isNotificationTone("bell")).toBe(true);
    expect(isNotificationTone("siren")).toBe(false);
    expect(isNotificationTone("system")).toBe(false);
  });
});
