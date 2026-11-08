import { afterEach, describe, expect, it } from "vitest";

import type { AndroidDriver } from "../../AndroidDriver.js";
import { DeviceManager } from "../../DeviceManager.js";
import { FakeDriver } from "../../FakeDriver.js";
import { createMobileControlActions } from "../../MobileControlActions.js";
import { createMobileDev, type MobileDev } from "../index.js";
import { createTestDevHost } from "../testHost.js";
import { agentChanges, createConditions } from "./index.js";

const pixel = {
  deviceId: "android-avd:Pixel_7",
  platform: "android",
  kind: "emulator",
  name: "Pixel 7",
  state: "online",
  serial: "emulator-5554",
} as const;
const phone = { ...pixel, deviceId: "android:R58M", kind: "physical", name: "Galaxy", serial: "R58M" } as const;
const iphone = {
  deviceId: "ios:UDID-1",
  platform: "ios",
  kind: "simulator",
  name: "iPhone 16",
  state: "online",
} as const;
const worktrees = [{ worktreeId: "wt-1", path: "/repo/app", status: "ready" }];

let dev: MobileDev | undefined;
afterEach(async () => {
  await dev?.dispose();
  dev = undefined;
});

async function setup() {
  const android = new FakeDriver("android", [pixel, phone]);
  const ios = new FakeDriver("ios", [iphone]);
  const devices = new DeviceManager({
    android: android as unknown as AndroidDriver,
    ios,
    scrcpyServer: async () => "/zli/scrcpy-server",
  });
  await devices.list();
  const host = createTestDevHost({ worktrees, manager: devices });
  dev = createMobileDev(host);
  const dispatch = createMobileControlActions({
    manager: () => devices,
    worktrees: () => worktrees,
    settings: async () => host.settingsValue,
    status: async () => ({ android: { missing: [] }, ios: { supported: false, missing: [] } }) as never,
    reveal: () => undefined,
    platform: "linux",
    dev,
  });
  return { android, ios, devices, dev, dispatch, conditions: createConditions(host) };
}

describe("the device settings feature", () => {
  it("joins mobile dev with its action and channels", async () => {
    const { dev } = await setup();
    expect(Object.keys(dev.actions)).toContain("mobiledevicesettings");
    expect(Object.keys(dev.ipc)).toEqual(
      expect.arrayContaining([
        "zli:mobile:conditions:get",
        "zli:mobile:conditions:appearance",
        "zli:mobile:conditions:text-size",
        "zli:mobile:conditions:location",
        "zli:mobile:conditions:clear-location",
        "zli:mobile:conditions:permission",
        "zli:mobile:conditions:notify",
      ]),
    );
  });

  it("changes the device from the panel and reads it back", async () => {
    const { android, conditions } = await setup();
    const ipc = conditions.ipc;
    expect(await ipc["zli:mobile:conditions:appearance"]?.({ deviceId: pixel.deviceId, appearance: "dark" })).toEqual({
      message: "Switched Pixel 7 to dark appearance.",
    });
    expect(await ipc["zli:mobile:conditions:text-size"]?.({ deviceId: pixel.deviceId, textSize: "large" })).toEqual({
      message: "Set the text size on Pixel 7 to Large.",
    });
    expect(await ipc["zli:mobile:conditions:get"]?.({ deviceId: pixel.deviceId })).toEqual({
      appearance: "dark",
      textSize: "large",
    });
    await ipc["zli:mobile:conditions:location"]?.({ deviceId: pixel.deviceId, latitude: 51.5074, longitude: -0.1278 });
    await ipc["zli:mobile:conditions:permission"]?.({
      deviceId: pixel.deviceId,
      appId: "com.example.app",
      permission: "camera",
      grant: false,
    });
    expect(android.actions).toEqual([
      `appearance ${pixel.deviceId} dark`,
      `text-size ${pixel.deviceId} large`,
      `location ${pixel.deviceId} 51.5074,-0.1278`,
      `revoke ${pixel.deviceId} com.example.app camera`,
    ]);
  });

  it("refuses what a device cannot take before running anything", async () => {
    const { android, ios, conditions } = await setup();
    const ipc = conditions.ipc;
    await expect(
      ipc["zli:mobile:conditions:location"]?.({ deviceId: phone.deviceId, latitude: 1, longitude: 2 }),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("only on an emulator") });
    await expect(
      ipc["zli:mobile:conditions:notify"]?.({
        deviceId: pixel.deviceId,
        appId: "com.example.app",
        title: "Hi",
        body: "",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      ipc["zli:mobile:conditions:permission"]?.({
        deviceId: iphone.deviceId,
        appId: "com.example.app",
        permission: "camera",
        grant: true,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(android.actions).toEqual([]);
    expect(ios.actions).toEqual([]);
  });

  it("rejects unsafe input on the channels", async () => {
    const { android, conditions } = await setup();
    const ipc = conditions.ipc;
    expect(() =>
      ipc["zli:mobile:conditions:permission"]?.({
        deviceId: pixel.deviceId,
        appId: "com.example;reboot",
        permission: "camera",
        grant: true,
      }),
    ).toThrow();
    expect(() =>
      ipc["zli:mobile:conditions:location"]?.({ deviceId: pixel.deviceId, latitude: 95, longitude: 0 }),
    ).toThrow();
    expect(() =>
      ipc["zli:mobile:conditions:appearance"]?.({ deviceId: pixel.deviceId, appearance: "sepia" }),
    ).toThrow();
    expect(android.actions).toEqual([]);
  });

  it("refuses panel changes while an agent holds the device", async () => {
    const { android, devices, conditions } = await setup();
    devices.acquireForAgent(pixel.deviceId, { ownerId: "agent:wt-1", ownerLabel: "Claude", kind: "agent" });
    await expect(
      conditions.ipc["zli:mobile:conditions:appearance"]?.({ deviceId: pixel.deviceId, appearance: "dark" }),
    ).rejects.toThrow(/Claude is driving this device/u);
    expect(android.actions).toEqual([]);
  });

  it("applies an agent's changes in order and says what each did", async () => {
    const { ios, dispatch } = await setup();
    const result = await dispatch("mobiledevicesettings", {
      cwd: "/repo/app",
      deviceId: iphone.deviceId,
      appearance: "dark",
      latitude: 35.6762,
      longitude: 139.6503,
      appId: "com.example.app",
      grant: ["location"],
      notificationTitle: "Order shipped",
    });
    expect(result).toMatchObject({
      deviceId: iphone.deviceId,
      done: [
        "Switched iPhone 16 to dark appearance.",
        "Set the location on iPhone 16 to 35.6762, 139.6503.",
        "Granted location to com.example.app.",
        "Sent a test notification to com.example.app.",
      ],
    });
    expect(ios.actions).toEqual([
      `appearance ${iphone.deviceId} dark`,
      `location ${iphone.deviceId} 35.6762,139.6503`,
      `grant ${iphone.deviceId} com.example.app location`,
      `notify ${iphone.deviceId} com.example.app Order shipped|`,
    ]);
  });

  it("tells the agent what changed before a step it could not take", async () => {
    const { android, dispatch } = await setup();
    await expect(
      dispatch("mobiledevicesettings", {
        cwd: "/repo/app",
        deviceId: phone.deviceId,
        textSize: "largest",
        latitude: 1,
        longitude: 2,
      }),
    ).rejects.toThrow(/^Set the text size on Galaxy to Largest\. Then it stopped: ZLI can set the location only/u);
    expect(android.actions).toEqual([`text-size ${phone.deviceId} largest`]);
  });

  it("orders the agent's changes and skips app changes without an app id", () => {
    expect(
      agentChanges({
        cwd: "/repo/app",
        revoke: ["camera"],
        clearLocation: true,
        textSize: "small",
        appId: "com.example.app",
        grant: ["photos"],
      } as never).map((change) => change.kind),
    ).toEqual(["textSize", "clearLocation", "permission", "permission"]);
  });
});
