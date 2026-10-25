import { describe, expect, it, vi } from "vitest";

import type { AndroidDriver } from "./AndroidDriver.js";
import { DeviceManager } from "./DeviceManager.js";
import { FakeDriver } from "./FakeDriver.js";
import type { MobileService } from "./MobileService.js";
import { mobileIpcHandlers } from "./mobileIpc.js";

const pixel = {
  deviceId: "android-avd:Pixel_8",
  platform: "android",
  kind: "emulator",
  name: "Pixel 8",
  state: "online",
  serial: "emulator-5554",
} as const;

function handlers() {
  const android = new FakeDriver("android", [pixel]);
  android.openUrl = async (device, url) => {
    android.actions.push(`open ${device.deviceId} ${url}`);
    return url.includes("localhost") ? { reversedPort: 8081 } : {};
  };
  const logs = vi.spyOn(android, "logs");
  const manager = new DeviceManager({
    android: android as unknown as AndroidDriver,
    ios: new FakeDriver("ios", []),
    scrcpyServer: async () => "/zli/scrcpy-server",
  });
  const service = { manager, setup: {}, status: async () => ({}) } as unknown as MobileService;
  const settings = { get: vi.fn(async () => ({ agentTools: true })), set: vi.fn(async () => ({ agentTools: false })) };
  return {
    android,
    logs,
    manager,
    settings,
    handle: mobileIpcHandlers({ service: () => service, settings: () => settings }),
  };
}

describe("mobile IPC handlers", () => {
  it("opens URLs, reads logs, and launches apps through the device manager", async () => {
    const { android, logs, handle } = handlers();
    expect(await handle["zli:mobile:open-url"]?.({ deviceId: pixel.deviceId, url: "exp://localhost:8081" })).toEqual({
      reversedPort: 8081,
    });
    expect(
      await handle["zli:mobile:logs"]?.({ deviceId: pixel.deviceId, appId: "com.example.app", lines: 50, filter: "E" }),
    ).toEqual(["50 lines"]);
    expect(logs).toHaveBeenLastCalledWith(expect.objectContaining({ deviceId: pixel.deviceId }), {
      lines: 50,
      appId: "com.example.app",
      filter: "E",
    });
    expect(await handle["zli:mobile:logs"]?.({ deviceId: pixel.deviceId })).toEqual(["200 lines"]);
    expect(await handle["zli:mobile:launch"]?.({ deviceId: pixel.deviceId, appId: "com.example.app" })).toEqual({
      accepted: true,
    });
    expect(android.actions).toEqual([
      `open ${pixel.deviceId} exp://localhost:8081`,
      `launch ${pixel.deviceId} com.example.app`,
    ]);
  });

  it("validates every payload in main, whatever the renderer sent", async () => {
    const { android, handle } = handlers();
    expect(() => handle["zli:mobile:open-url"]?.({ deviceId: pixel.deviceId })).toThrow();
    expect(() => handle["zli:mobile:logs"]?.({ deviceId: pixel.deviceId, appId: "$(reboot)" })).toThrow();
    await expect(
      Promise.resolve().then(() => handle["zli:mobile:launch"]?.({ deviceId: pixel.deviceId, appId: "a; reboot" })),
    ).rejects.toThrow();
    expect(() => handle["zli:mobile:boot"]?.({ deviceId: "" })).toThrow();
    expect(android.actions).toEqual([]);
  });

  it("refuses panel actions while an agent holds the device", async () => {
    const { android, manager, handle } = handlers();
    await manager.list();
    manager.acquireForAgent(pixel.deviceId, { ownerId: "agent:1", ownerLabel: "Claude", kind: "agent" });
    await expect(
      handle["zli:mobile:open-url"]?.({ deviceId: pixel.deviceId, url: "https://example.com" }) as Promise<unknown>,
    ).rejects.toThrow("Claude is driving this device. Take over to use it.");
    await expect(handle["zli:mobile:logs"]?.({ deviceId: pixel.deviceId }) as Promise<unknown>).rejects.toThrow(
      "Take over",
    );
    expect(android.actions).toEqual([]);
  });

  it("keeps the existing channels, and says when the mobile service is not running", async () => {
    const { handle, settings } = handlers();
    expect(Object.keys(handle)).toEqual(
      expect.arrayContaining([
        "zli:mobile:status",
        "zli:mobile:devices",
        "zli:mobile:boot",
        "zli:mobile:shutdown",
        "zli:mobile:input",
        "zli:mobile:screenshot",
        "zli:mobile:settings-get",
        "zli:mobile:settings-set",
      ]),
    );
    await handle["zli:mobile:settings-set"]?.({ agentTools: false });
    expect(settings.set).toHaveBeenCalledWith({ agentTools: false });
    const stopped = mobileIpcHandlers({ service: () => undefined, settings: () => undefined });
    expect(() => stopped["zli:mobile:devices"]?.(undefined)).toThrow("ZLI's mobile service is not running.");
    expect(() => stopped["zli:mobile:settings-get"]?.(undefined)).toThrow("ZLI's mobile service is not running.");
  });
});
