import { describe, expect, it } from "vitest";

import {
  MOBILE_CONTROL_ACTIONS,
  MobileAvdCreateInput,
  MobileAvdDeleteInput,
  MobileAvdName,
  MobileControlLaunchInput,
  MobileControlSwipeInput,
  MobileControlTapInput,
  MobileLogLines,
  MobileOpenUrlResult,
  MobilePanelInput,
  MobilePanelLaunchInput,
  MobilePanelLogsInput,
  MobilePanelOpenUrlInput,
  MobilePopOutAspectInput,
  MobilePopOutList,
  MobilePopOutPinInput,
  MobileSetupRunInput,
} from "./mobile.js";

describe("mobile contracts", () => {
  it("names every control action with lowercase letters only, as the control route requires", () => {
    for (const action of MOBILE_CONTROL_ACTIONS) expect(action).toMatch(/^[a-z]+$/u);
  });

  it("takes a tap by ref or by both coordinates, never both or half", () => {
    expect(MobileControlTapInput.safeParse({ ref: "e3" }).success).toBe(true);
    expect(MobileControlTapInput.safeParse({ x: 10, y: 20 }).success).toBe(true);
    expect(MobileControlTapInput.safeParse({ ref: "e3", x: 1, y: 2 }).success).toBe(false);
    expect(MobileControlTapInput.safeParse({ x: 10 }).success).toBe(false);
    expect(MobileControlTapInput.safeParse({}).success).toBe(false);
    expect(MobileControlTapInput.safeParse({ ref: "button" }).success).toBe(false);
  });

  it("takes a swipe by direction or by four coordinates", () => {
    expect(MobileControlSwipeInput.safeParse({ direction: "up" }).success).toBe(true);
    expect(MobileControlSwipeInput.safeParse({ fromX: 1, fromY: 2, toX: 3, toY: 4 }).success).toBe(true);
    expect(MobileControlSwipeInput.safeParse({ fromX: 1, fromY: 2 }).success).toBe(false);
  });

  it("rejects app ids that could carry shell syntax", () => {
    expect(MobileControlLaunchInput.safeParse({ appId: "com.example.app" }).success).toBe(true);
    expect(MobileControlLaunchInput.safeParse({ appId: "com.example/.MainActivity" }).success).toBe(true);
    expect(MobileControlLaunchInput.safeParse({ appId: "com.example; reboot" }).success).toBe(false);
  });

  it("parses panel input by type", () => {
    expect(
      MobilePanelInput.parse({ type: "touch", deviceId: "android:emulator-5554", action: "down", x: 1, y: 2 }),
    ).toMatchObject({ type: "touch" });
    expect(MobilePanelInput.safeParse({ type: "button", deviceId: "d", button: "explode" }).success).toBe(false);
    for (const button of ["tab", "dpad_up", "dpad_down", "dpad_left", "dpad_right"])
      expect(MobilePanelInput.safeParse({ type: "button", deviceId: "d", button }).success).toBe(true);
    expect(MobileSetupRunInput.parse({ acceptedLicenses: ["android-sdk-license"] }).acceptedLicenses).toHaveLength(1);
  });

  it("parses panel Open URL, Launch, and Logs input without a worktree target", () => {
    expect(MobilePanelOpenUrlInput.parse({ deviceId: "d", url: "exp://localhost:8081" })).toEqual({
      deviceId: "d",
      url: "exp://localhost:8081",
    });
    expect(MobilePanelOpenUrlInput.safeParse({ deviceId: "d", url: "" }).success).toBe(false);
    expect(MobilePanelLaunchInput.safeParse({ deviceId: "d", appId: "com.example.app", stop: true }).success).toBe(
      true,
    );
    expect(MobilePanelLaunchInput.safeParse({ deviceId: "d", appId: "com.example; reboot" }).success).toBe(false);
    expect(MobilePanelLogsInput.parse({ deviceId: "d" })).toEqual({ deviceId: "d" });
    expect(MobilePanelLogsInput.safeParse({ deviceId: "d", appId: "$(reboot)" }).success).toBe(false);
    expect(MobilePanelLogsInput.safeParse({ deviceId: "d", lines: 2_001 }).success).toBe(false);
    expect(MobilePanelLogsInput.safeParse({ deviceId: "d", filter: "" }).success).toBe(false);
    expect(MobileOpenUrlResult.parse({ reversedPort: 8081 })).toEqual({ reversedPort: 8081 });
    expect(MobileOpenUrlResult.safeParse({ reversedPort: 70_000 }).success).toBe(false);
    expect(MobileLogLines.safeParse(Array.from({ length: 2_001 }, () => "line")).success).toBe(false);
  });

  it("takes virtual device names avdmanager accepts, at most 60 characters", () => {
    for (const name of ["Pixel_8", "ZLI-Pixel.35", "a"]) expect(MobileAvdName.safeParse(name).success).toBe(true);
    for (const name of ["", "Pixel 8", "a;reboot", "../avd", "-rf", "$(x)", "é", "x".repeat(61)])
      expect(MobileAvdName.safeParse(name).success).toBe(false);
    expect(MobileAvdName.safeParse("x".repeat(60)).success).toBe(true);
    expect(MobileAvdName.safeParse("Pixel 8").error?.issues[0]?.message).toBe(
      "Use letters, digits, and _ . - only, starting with a letter or digit.",
    );
    expect(
      MobileAvdCreateInput.parse({ name: "Pixel_9", systemImage: "system-images;android-35;google_apis;x86_64" }),
    ).toEqual({ name: "Pixel_9", systemImage: "system-images;android-35;google_apis;x86_64" });
    expect(
      MobileAvdCreateInput.safeParse({ name: "Pixel_9", systemImage: "system-images;android-35;x86_64 --force" })
        .success,
    ).toBe(false);
    expect(
      MobileAvdCreateInput.safeParse({
        name: "Pixel_9",
        systemImage: "system-images;android-35;google_apis;x86_64",
        device: "pixel 7",
      }).success,
    ).toBe(false);
    expect(MobileAvdDeleteInput.safeParse({ name: "Pixel_8" }).success).toBe(true);
    expect(MobileAvdDeleteInput.safeParse({ name: "-rf" }).success).toBe(false);
  });

  it("parses pop-out windows, their pin, and the device shape they keep", () => {
    expect(MobilePopOutList.parse([{ deviceId: "android-avd:Pixel_8", pinned: true }])).toHaveLength(1);
    expect(MobilePopOutList.safeParse([{ deviceId: "", pinned: false }]).success).toBe(false);
    expect(MobilePopOutPinInput.safeParse({ deviceId: "d", pinned: "yes" }).success).toBe(false);
    expect(MobilePopOutAspectInput.parse({ deviceId: "d", aspect: 0.47, extraWidth: 24, extraHeight: 120 })).toEqual({
      deviceId: "d",
      aspect: 0.47,
      extraWidth: 24,
      extraHeight: 120,
    });
    expect(MobilePopOutAspectInput.safeParse({ deviceId: "d", aspect: 0, extraWidth: 0, extraHeight: 0 }).success).toBe(
      false,
    );
    expect(
      MobilePopOutAspectInput.safeParse({ deviceId: "d", aspect: 1, extraWidth: -1, extraHeight: 0 }).success,
    ).toBe(false);
    expect(
      MobilePopOutAspectInput.safeParse({ deviceId: "d", aspect: Number.NaN, extraWidth: 0, extraHeight: 0 }).success,
    ).toBe(false);
  });
});
