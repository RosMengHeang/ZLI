import type { MobileSettings, MobileSetupStatus } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import type { AndroidDriver } from "./AndroidDriver.js";
import { DeviceManager } from "./DeviceManager.js";
import { FakeDriver } from "./FakeDriver.js";
import { createMobileControlActions, isMobileControlAction, swipeForDirection } from "./MobileControlActions.js";

const pixel = {
  deviceId: "android-avd:Pixel_7",
  platform: "android",
  kind: "emulator",
  name: "Pixel 7",
  state: "online",
  serial: "emulator-5554",
} as const;
const tablet = {
  deviceId: "android-avd:Tablet",
  platform: "android",
  kind: "emulator",
  name: "Tablet",
  state: "shutdown",
} as const;

const worktrees = [
  { worktreeId: "wt-1", path: "/repo/app", status: "ready" },
  { worktreeId: "wt-2", path: "/repo/other", status: "ready" },
];

const status = {
  host: { os: "linux", arch: "x64" },
  android: { missing: [] },
  ios: { supported: false, missing: ["Xcode"] },
} as unknown as MobileSetupStatus;

function setup() {
  const android = new FakeDriver("android", [pixel, tablet]);
  const ios = new FakeDriver("ios", []);
  const devices = new DeviceManager({
    android: android as unknown as AndroidDriver,
    ios,
    scrcpyServer: async () => "/zli/scrcpy-server",
  });
  const settings: MobileSettings = { agentTools: true };
  const reveals: string[] = [];
  const dispatch = createMobileControlActions({
    manager: () => devices,
    worktrees: () => worktrees,
    settings: async () => settings,
    status: async () => status,
    reveal: (event) => reveals.push(event.deviceId),
    platform: "linux",
    bootWaitMs: 20,
  });
  return { android, devices, settings, reveals, dispatch };
}

const inApp = { cwd: "/repo/app/src" };
const inOther = { cwd: "/repo/other" };

describe("mobile control actions", () => {
  it("recognizes only mobile actions", () => {
    expect(isMobileControlAction("mobiletap")).toBe(true);
    expect(isMobileControlAction("click")).toBe(false);
  });

  it("lists devices with who holds them and whether each platform is ready", async () => {
    const { dispatch } = setup();
    await dispatch("mobiletap", { ...inApp, x: 1, y: 2 });
    const listed = (await dispatch("mobiledevices", inOther)) as {
      devices: Array<{ deviceId: string; heldBy: string | null }>;
      android: { ready: boolean };
      ios: { ready: boolean; missing: string[] };
    };
    expect(listed.devices).toEqual([
      expect.objectContaining({ deviceId: pixel.deviceId, heldBy: "The agent in app" }),
      expect.objectContaining({ deviceId: tablet.deviceId, heldBy: null }),
    ]);
    expect(listed.android.ready).toBe(true);
    expect(listed.ios).toEqual({ ready: false, missing: ["iOS Simulator needs a Mac with Xcode."] });
  });

  it("gives each worktree its own device and refuses a device another agent holds", async () => {
    const { dispatch, android } = setup();
    await dispatch("mobilepress", { ...inApp, button: "home" });
    await expect(
      dispatch("mobilepress", { ...inOther, deviceId: pixel.deviceId, button: "back" }),
    ).rejects.toMatchObject({
      status: 423,
      message: expect.stringMatching(/The agent in app is using this device/u),
    });
    await expect(dispatch("mobilepress", { ...inOther, button: "back" })).rejects.toMatchObject({ status: 409 });
    await dispatch("mobilerelease", inApp);
    await dispatch("mobilepress", { ...inOther, button: "back" });
    expect(android.actions).toEqual(["press android-avd:Pixel_7 home", "press android-avd:Pixel_7 back"]);
  });

  it("stops agents once the person takes over in the panel", async () => {
    const { dispatch, devices } = setup();
    await dispatch("mobilepress", { ...inApp, button: "home" });
    devices.takeOver(pixel.deviceId);
    await expect(dispatch("mobilepress", { ...inApp, button: "home" })).rejects.toMatchObject({
      status: 423,
      message: expect.stringMatching(/took over/u),
    });
  });

  it("taps the center of an element from the latest snapshot", async () => {
    const { dispatch, android } = setup();
    android.tree = {
      nodes: [{ ref: "e1", role: "button", text: "Sign in", bounds: { x: 100, y: 200, width: 300, height: 100 } }],
      depths: [0],
    };
    await expect(dispatch("mobiletap", { ...inApp, ref: "e1" })).rejects.toMatchObject({ status: 409 });
    const snapshot = (await dispatch("mobilesnapshot", inApp)) as { tree: string; units: string };
    expect(snapshot.tree).toContain("[e1] button");
    expect(snapshot.units).toBe("pixels");
    expect(await dispatch("mobiletap", { ...inApp, ref: "e1" })).toMatchObject({ tapped: { x: 250, y: 250 } });
    await expect(dispatch("mobiletap", { ...inApp, ref: "e9" })).rejects.toMatchObject({ status: 404 });
    expect(android.actions).toEqual(["tap android-avd:Pixel_7 250,250"]);
  });

  it("boots a device that is off, shows it in the panel, and reports when the boot outlasts the wait", async () => {
    const { dispatch, android, reveals } = setup();
    const booted = (await dispatch("mobileboot", { ...inApp, deviceId: tablet.deviceId })) as {
      device: { state: string };
    };
    expect(booted.device.state).toBe("online");
    expect(reveals).toEqual([tablet.deviceId]);

    android.boot = () => new Promise(() => undefined);
    android.devices = android.devices.map((device) => ({ ...device, state: "shutdown" }));
    const slow = (await dispatch("mobileboot", { ...inOther, deviceId: pixel.deviceId })) as { booting: boolean };
    expect(slow.booting).toBe(true);
  });

  it("answers access checks when off and refuses every other action", async () => {
    const { dispatch, settings } = setup();
    settings.agentTools = false;
    expect(await dispatch("mobileaccess", {})).toEqual({ enabled: false });
    await expect(dispatch("mobiledevices", inApp)).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(/turned off/u),
    });
  });

  it("returns screenshots as base64 PNG", async () => {
    const { dispatch } = setup();
    expect(await dispatch("mobilescreenshot", inApp)).toMatchObject({
      mimeType: "image/png",
      width: 1080,
      height: 2400,
      data: Buffer.from("png").toString("base64"),
    });
  });

  it("swipes across the middle half of the screen", () => {
    expect(swipeForDirection("up", { width: 1000, height: 2000 })).toEqual({
      from: { x: 500, y: 1500 },
      to: { x: 500, y: 500 },
    });
  });
});
