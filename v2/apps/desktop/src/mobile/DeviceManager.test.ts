import type { MobilePanelInput } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import type { AndroidDriver } from "./AndroidDriver.js";
import { DeviceManager, type MobileStreamMessage, scrcpyMessagesFor } from "./DeviceManager.js";
import { FakeDriver } from "./FakeDriver.js";
import { FakeProcessRunner } from "./FakeProcessRunner.js";
import { encodeInjectKeycode, encodeInjectText, encodeRotateDevice, KeyAction } from "./scrcpy/protocol.js";

const pixel = {
  deviceId: "android-avd:Pixel_7",
  platform: "android",
  kind: "emulator",
  name: "Pixel 7",
  state: "online",
  serial: "emulator-5554",
} as const;
const iphone = {
  deviceId: "ios:UDID-1",
  platform: "ios",
  kind: "simulator",
  name: "iPhone 16",
  state: "online",
} as const;

const agent = { ownerId: "agent:wt-1", ownerLabel: "The agent in app", kind: "agent" } as const;

function androidFake(): FakeDriver & Pick<AndroidDriver, "connection"> {
  const driver = new FakeDriver("android", [pixel]) as FakeDriver & Pick<AndroidDriver, "connection">;
  driver.connection = async () => ({ runner: new FakeProcessRunner(), adb: "adb", serial: "emulator-5554", env: {} });
  return driver;
}

function manager(options: { scrcpyFails?: boolean } = {}) {
  const android = androidFake();
  const ios = new FakeDriver("ios", [iphone]);
  const messages: MobileStreamMessage[] = [];
  const sent: Buffer[] = [];
  const devices = new DeviceManager({
    android: android as unknown as AndroidDriver,
    ios,
    scrcpyServer: async () => "/zli/scrcpy-server",
    events: { stream: (message) => messages.push(message) },
    startScrcpy: async () => {
      if (options.scrcpyFails) throw new Error("adb forward failed");
      return { send: (message) => sent.push(message) > 0, close: async () => undefined, closed: false };
    },
    // Each stills loop takes one screenshot, then waits forever, so tests see exactly one still.
    sleep: () => new Promise<void>(() => undefined),
  });
  return { android, ios, devices, messages, sent };
}

describe("device manager", () => {
  it("lists devices from both platforms with their leases", async () => {
    const { devices } = manager();
    devices.acquireForAgent(pixel.deviceId, agent);
    const listed = await devices.list();
    expect(listed.map((device) => device.deviceId)).toEqual([pixel.deviceId, iphone.deviceId]);
    expect(listed[0]?.lease).toMatchObject({ ownerId: "agent:wt-1", kind: "agent" });
    expect(listed[1]?.lease).toBeNull();
  });

  it("streams Android video through scrcpy and sends panel input as control messages", async () => {
    const { devices, sent } = manager();
    expect(await devices.startStream(pixel.deviceId)).toEqual({
      deviceId: pixel.deviceId,
      mode: "video",
      width: 0,
      height: 0,
    });
    await devices.panelInput({ deviceId: pixel.deviceId, type: "text", text: "hi" });
    await devices.panelInput({ deviceId: pixel.deviceId, type: "rotate" });
    expect(sent).toEqual([encodeInjectText("hi"), encodeRotateDevice()]);
  });

  it("falls back to screenshots when scrcpy cannot start, and says why", async () => {
    const { devices, messages } = manager({ scrcpyFails: true });
    const info = await devices.startStream(pixel.deviceId);
    expect(info.mode).toBe("stills");
    expect(info.fallbackReason).toMatch(/adb forward failed/u);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messages.some((message) => message.type === "still" && message.width === 1080)).toBe(true);
  });

  it("turns a stills-mode press and release into a tap, scaled to iOS points", async () => {
    const { devices, ios } = manager();
    ios.size = { width: 1080, height: 2400 };
    await devices.startStream(iphone.deviceId);
    await new Promise((resolve) => setTimeout(resolve, 0));
    ios.size = { width: 540, height: 1200 };
    const touch = (action: "down" | "up", x: number, y: number): MobilePanelInput => ({
      deviceId: iphone.deviceId,
      type: "touch",
      action,
      x,
      y,
    });
    await devices.panelInput(touch("down", 200, 400));
    await devices.panelInput(touch("up", 202, 401));
    await devices.panelInput(touch("down", 500, 2000));
    await devices.panelInput(touch("up", 500, 600));
    expect(ios.actions).toEqual(["tap ios:UDID-1 100,200", "swipe ios:UDID-1 250,1000 250,300 100"]);
  });

  it("taps when a stills-mode press moves less than the slop, and swipes once it moves further", async () => {
    const { devices, android } = manager({ scrcpyFails: true });
    await devices.startStream(pixel.deviceId);
    const touch = (action: "down" | "up", x: number, y: number): MobilePanelInput => ({
      deviceId: pixel.deviceId,
      type: "touch",
      action,
      x,
      y,
    });
    await devices.panelInput(touch("down", 100, 100));
    await devices.panelInput(touch("up", 111, 100));
    await devices.panelInput(touch("down", 100, 100));
    await devices.panelInput(touch("up", 100, 112));
    expect(android.actions).toEqual([
      "tap android-avd:Pixel_7 100,100",
      "swipe android-avd:Pixel_7 100,100 100,112 100",
    ]);
  });

  it("cancels a boot when the device is shut down while booting", async () => {
    const ios = new FakeDriver("ios", [{ ...iphone, state: "shutdown" }]);
    ios.holdBoot = true;
    const states: string[] = [];
    const watched = new DeviceManager({
      android: androidFake() as unknown as AndroidDriver,
      ios,
      scrcpyServer: async () => "/zli/scrcpy-server",
      events: { devices: (next) => states.push(next.find((device) => device.platform === "ios")?.state ?? "") },
    });
    const booting = watched.boot(iphone.deviceId);
    const outcome = booting.catch((cause: unknown) => cause);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await watched.list()).find((device) => device.deviceId === iphone.deviceId)?.state).toBe("booting");

    await watched.shutdown(iphone.deviceId);
    expect(String(await outcome)).toMatch(/Booting iPhone 16 was cancelled/u);
    expect(ios.actions).toEqual(["boot ios:UDID-1", "shutdown ios:UDID-1"]);
    expect(states.at(-1)).toBe("shutdown");
    expect(states).toContain("booting");
  });

  it("blocks panel input while an agent holds the device, until the person takes over", async () => {
    const { devices, android } = manager({ scrcpyFails: true });
    devices.acquireForAgent(pixel.deviceId, agent);
    const press: MobilePanelInput = { deviceId: pixel.deviceId, type: "button", button: "home" };
    await expect(devices.panelInput(press)).rejects.toThrow(/The agent in app is driving this device/u);
    devices.takeOver(pixel.deviceId);
    await devices.panelInput(press);
    expect(android.actions).toEqual(["press android-avd:Pixel_7 home"]);
    expect(() => devices.acquireForAgent(pixel.deviceId, agent)).toThrow(/took over/u);
  });

  it("sends arrows and Tab through scrcpy as Android keycodes", () => {
    const frame = { width: 720, height: 1600 };
    const keys = { dpad_up: 19, dpad_down: 20, dpad_left: 21, dpad_right: 22, tab: 61 } as const;
    for (const [button, keycode] of Object.entries(keys))
      expect(
        scrcpyMessagesFor({ deviceId: pixel.deviceId, type: "button", button: button as keyof typeof keys }, frame),
      ).toEqual([encodeInjectKeycode(KeyAction.down, keycode), encodeInjectKeycode(KeyAction.up, keycode)]);
  });

  it("encodes a touch in the stream's frame size", () => {
    const [message] = scrcpyMessagesFor(
      { deviceId: pixel.deviceId, type: "touch", action: "down", x: 10, y: 20 },
      { width: 720, height: 1600 },
    );
    expect(message?.readUInt8(0)).toBe(2);
    expect(message?.readInt32BE(10)).toBe(10);
    expect(message?.readInt32BE(14)).toBe(20);
    expect(message?.readUInt16BE(18)).toBe(720);
    expect(message?.readUInt16BE(20)).toBe(1600);
  });
});
