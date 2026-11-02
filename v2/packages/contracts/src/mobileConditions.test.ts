import { describe, expect, it } from "vitest";

import {
  DeviceAppId,
  DeviceLocation,
  deviceConditionSupport,
  MobileControlDeviceSettingsInput,
  MobileNotificationInput,
  MobilePermissionInput,
} from "./mobileConditions.js";

const target = { cwd: "/repo/app" };

describe("device settings contracts", () => {
  it("takes app ids that are safe to pass to adb and simctl", () => {
    expect(DeviceAppId.parse(" com.example.app ")).toBe("com.example.app");
    expect(DeviceAppId.parse("host.exp.Exponent")).toBe("host.exp.Exponent");
    for (const bad of [
      "com",
      "com.example;reboot",
      "com.example app",
      "-g.example",
      "$(id).app",
      "com.example\nreboot",
    ])
      expect(DeviceAppId.safeParse(bad).success, bad).toBe(false);
  });

  it("keeps a location on the globe", () => {
    expect(DeviceLocation.safeParse({ latitude: 90, longitude: -180 }).success).toBe(true);
    expect(DeviceLocation.safeParse({ latitude: 90.1, longitude: 0 }).success).toBe(false);
    expect(DeviceLocation.safeParse({ latitude: 0, longitude: 180.5 }).success).toBe(false);
    expect(DeviceLocation.safeParse({ latitude: Number.NaN, longitude: 0 }).success).toBe(false);
  });

  it("checks permission and notification input from the panel", () => {
    const base = { deviceId: "android-avd:Pixel_7", appId: "com.example.app" };
    expect(MobilePermissionInput.safeParse({ ...base, permission: "camera", grant: true }).success).toBe(true);
    expect(MobilePermissionInput.safeParse({ ...base, permission: "bluetooth", grant: true }).success).toBe(false);
    expect(MobileNotificationInput.safeParse({ ...base, title: "Hi", body: "" }).success).toBe(true);
    expect(MobileNotificationInput.safeParse({ ...base, title: " ", body: "" }).success).toBe(false);
  });

  it("asks the agent for a coherent set of changes", () => {
    const messages = (input: object) => {
      const parsed = MobileControlDeviceSettingsInput.safeParse({ ...target, ...input });
      return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
    };
    expect(messages({ appearance: "dark", textSize: "largest" })).toEqual([]);
    expect(messages({})).toEqual(["Pass at least one setting to change."]);
    expect(messages({ latitude: 10 })).toContain("Pass both latitude and longitude.");
    expect(messages({ latitude: 1, longitude: 2, clearLocation: true })).toContain(
      "Set a location or clear it, not both.",
    );
    expect(messages({ grant: ["camera"] })).toContain(
      "Permissions and test notifications need appId, such as com.example.app.",
    );
    expect(messages({ appId: "com.example.app", grant: ["camera"], revoke: ["camera"] })).toContain(
      "Grant or revoke camera, not both.",
    );
    expect(messages({ appId: "com.example.app" })).toEqual(["Pass at least one setting to change."]);
  });

  it("says which settings each kind of device takes", () => {
    const emulator = deviceConditionSupport({ platform: "android", kind: "emulator" });
    expect(emulator.location.ok).toBe(true);
    expect(emulator.notification.ok).toBe(false);
    expect(emulator.clearLocation.ok).toBe(false);
    expect(Object.values(emulator.permissions).every((entry) => entry.ok)).toBe(true);
    const phone = deviceConditionSupport({ platform: "android", kind: "physical" });
    expect(phone.location).toMatchObject({ ok: false });
    expect(phone.appearance.ok && phone.textSize.ok).toBe(true);
    expect(Object.values(phone.permissions).every((entry) => entry.ok)).toBe(true);

    const simulator = deviceConditionSupport({ platform: "ios", kind: "simulator" });
    expect(simulator.notification.ok).toBe(true);
    expect(simulator.permissions.camera.ok).toBe(false);
    expect(simulator.permissions.photos.ok).toBe(true);
    const iphone = deviceConditionSupport({ platform: "ios", kind: "physical" });
    expect(iphone.appearance).toEqual({ ok: false, reason: "ZLI changes these settings only on iOS simulators." });
  });
});
