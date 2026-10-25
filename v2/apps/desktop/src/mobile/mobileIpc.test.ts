import { describe, expect, it, vi } from "vitest";

import type { AndroidDriver } from "./AndroidDriver.js";
import { DeviceManager } from "./DeviceManager.js";
import { FakeDriver } from "./FakeDriver.js";
import type { MobileService } from "./MobileService.js";
import { mobileIpcHandlers, streamViewer } from "./mobileIpc.js";

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
    startScrcpy: async () => ({ send: () => true, close: async () => undefined, closed: false }),
  });
  const avds = {
    list: vi.fn(async () => ({ avds: [] })),
    create: vi.fn(async (_input: unknown) => ({ avds: [] })),
    delete: vi.fn(async (_input: unknown) => ({ avds: [] })),
  };
  const service = { manager, setup: {}, avds, status: async () => ({}) } as unknown as MobileService;
  const settings = { get: vi.fn(async () => ({ agentTools: true })), set: vi.fn(async () => ({ agentTools: false })) };
  return {
    android,
    avds,
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
  it("parses virtual device requests before they reach avdmanager", async () => {
    const { avds, handle } = handlers();
    const image = "system-images;android-35;google_apis;x86_64";
    expect(await handle["zli:mobile:avd-list"]?.(undefined)).toEqual({ avds: [] });
    await handle["zli:mobile:avd-create"]?.({ name: "Pixel_9", systemImage: image, device: "pixel_8" });
    await handle["zli:mobile:avd-delete"]?.({ name: "Pixel_9" });
    expect(avds.create).toHaveBeenCalledWith({ name: "Pixel_9", systemImage: image, device: "pixel_8" });
    expect(avds.delete).toHaveBeenCalledWith({ name: "Pixel_9" });
    expect(() => handle["zli:mobile:avd-create"]?.({ name: "Pixel 9", systemImage: image })).toThrow();
    expect(() => handle["zli:mobile:avd-create"]?.({ name: "Pixel_9", systemImage: `${image} --force` })).toThrow();
    expect(() => handle["zli:mobile:avd-delete"]?.({ name: "--all" })).toThrow();
    expect(avds.create).toHaveBeenCalledTimes(1);
    expect(avds.delete).toHaveBeenCalledTimes(1);
  });

  it("starts and stops streams as the window that asked, so one window never stops another's view", async () => {
    const { manager, handle } = handlers();
    const panel = { viewer: streamViewer(1) };
    const popOut = { viewer: streamViewer(2) };
    expect(panel.viewer).toBe("window-1");
    await handle["zli:mobile:stream-start"]?.({ deviceId: pixel.deviceId }, panel);
    await handle["zli:mobile:stream-start"]?.({ deviceId: pixel.deviceId }, popOut);
    expect(manager.viewerCount(pixel.deviceId)).toBe(2);
    await handle["zli:mobile:stream-stop"]?.({ deviceId: pixel.deviceId }, panel);
    expect(manager.viewerCount(pixel.deviceId)).toBe(1);
    await handle["zli:mobile:stream-stop"]?.({ deviceId: pixel.deviceId }, popOut);
    expect(manager.viewerCount(pixel.deviceId)).toBe(0);
  });

  it("opens, pins, shapes, and closes pop-out windows with parsed payloads", async () => {
    const popOuts = {
      list: vi.fn(() => [{ deviceId: pixel.deviceId, pinned: false }]),
      open: vi.fn(async (deviceId: string) => [{ deviceId, pinned: false }]),
      close: vi.fn((_deviceId: string) => []),
      pin: vi.fn(async (deviceId: string, pinned: boolean) => [{ deviceId, pinned }]),
      setAspect: vi.fn(),
    };
    const handle = mobileIpcHandlers({ service: () => undefined, settings: () => undefined, popOuts: () => popOuts });
    expect(await handle["zli:mobile:popout-open"]?.({ deviceId: pixel.deviceId })).toEqual([
      { deviceId: pixel.deviceId, pinned: false },
    ]);
    expect(await handle["zli:mobile:popout-pin"]?.({ deviceId: pixel.deviceId, pinned: true })).toEqual([
      { deviceId: pixel.deviceId, pinned: true },
    ]);
    expect(
      handle["zli:mobile:popout-aspect"]?.({ deviceId: pixel.deviceId, aspect: 0.47, extraWidth: 24, extraHeight: 96 }),
    ).toEqual({ accepted: true });
    expect(popOuts.setAspect).toHaveBeenCalledWith({
      deviceId: pixel.deviceId,
      aspect: 0.47,
      extraWidth: 24,
      extraHeight: 96,
    });
    expect(handle["zli:mobile:popout-close"]?.({ deviceId: pixel.deviceId })).toEqual([]);
    expect(handle["zli:mobile:popout-list"]?.(undefined)).toHaveLength(1);
    expect(() => handle["zli:mobile:popout-open"]?.({ deviceId: "" })).toThrow();
    expect(() => handle["zli:mobile:popout-pin"]?.({ deviceId: pixel.deviceId, pinned: "yes" })).toThrow();
    expect(() =>
      handle["zli:mobile:popout-aspect"]?.({ deviceId: pixel.deviceId, aspect: 50, extraWidth: 0, extraHeight: 0 }),
    ).toThrow();
    expect(popOuts.open).toHaveBeenCalledTimes(1);
    expect(popOuts.setAspect).toHaveBeenCalledTimes(1);
    const without = mobileIpcHandlers({ service: () => undefined, settings: () => undefined });
    expect(() => without["zli:mobile:popout-open"]?.({ deviceId: pixel.deviceId })).toThrow(
      "ZLI's pop-out windows are not ready yet.",
    );
  });
});
