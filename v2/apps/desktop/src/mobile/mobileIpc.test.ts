import { describe, expect, it, vi } from "vitest";

import type { AndroidDriver } from "./AndroidDriver.js";
import { DeviceManager } from "./DeviceManager.js";
import { createMobileDev } from "./dev/index.js";
import { createTestDevHost } from "./dev/testHost.js";
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
  const simulators = {
    list: vi.fn(async () => ({ simctl: true, deviceTypes: [], runtimes: [] })),
    create: vi.fn(async (_input: unknown) => ({ deviceId: "ios:1", name: "iPhone" })),
    delete: vi.fn(async (_input: unknown) => ({ accepted: true })),
  };
  const testIosHost = vi.fn(async (host: string) => ({ ok: true, message: `Connected to ${host}.` }));
  const service = {
    manager,
    setup: {},
    avds,
    simulators,
    status: async () => ({}),
    testIosHost,
  } as unknown as MobileService;
  const settings = {
    get: vi.fn(async () => ({ agentTools: true, crashWatch: true })),
    set: vi.fn(async () => ({ agentTools: false, crashWatch: true })),
  };
  return {
    android,
    avds,
    simulators,
    logs,
    manager,
    settings,
    testIosHost,
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

  it("checks Wi-Fi pairing input in main before adb sees it", async () => {
    const wireless = {
      pair: vi.fn(async () => ({ connected: true, message: "Paired and connected to Pixel 8." })),
      connect: vi.fn(async () => ({ connected: true, message: "Connected to Pixel 8." })),
      disconnect: vi.fn(async () => undefined),
    };
    const service = {
      manager: {},
      setup: {},
      avds: {},
      status: async () => ({}),
      wireless,
    } as unknown as MobileService;
    const handle = mobileIpcHandlers({ service: () => service, settings: () => undefined });
    await handle["zli:mobile:wifi-pair"]?.({ host: " 192.168.1.20 ", pairPort: 37_123, code: "123456" });
    expect(wireless.pair).toHaveBeenCalledWith({ host: "192.168.1.20", pairPort: 37_123, code: "123456" });
    await handle["zli:mobile:wifi-connect"]?.({ host: "192.168.1.20", port: 39_457 });
    expect(await handle["zli:mobile:wifi-disconnect"]?.({ deviceId: "android:192.168.1.20:39457" })).toEqual({
      accepted: true,
    });
    expect(wireless.disconnect).toHaveBeenCalledWith("android:192.168.1.20:39457");
    for (const bad of [
      { host: "192.168.1.20", pairPort: 37_123, code: "1234567" },
      { host: "192.168.1.20 && reboot", pairPort: 37_123, code: "123456" },
      { host: "--help", pairPort: 37_123, code: "123456" },
      { host: "192.168.1.20", pairPort: 0, code: "123456" },
    ])
      expect(() => handle["zli:mobile:wifi-pair"]?.(bad)).toThrow();
    expect(() => handle["zli:mobile:wifi-connect"]?.({ host: "192.168.1.20", port: "5555" })).toThrow();
    expect(wireless.pair).toHaveBeenCalledTimes(1);
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
  it("tests a Mac only with an address ssh cannot misread, and reads the devices again when the Mac changes", async () => {
    const { handle, testIosHost, manager, settings } = handlers();
    expect(await handle["zli:mobile:ios-host-test"]?.({ host: "dev@studio.local" })).toEqual({
      ok: true,
      message: "Connected to dev@studio.local.",
    });
    for (const host of ["-oProxyCommand=calc", "studio; reboot", ""])
      expect(() => handle["zli:mobile:ios-host-test"]?.({ host })).toThrow();
    expect(testIosHost).toHaveBeenCalledTimes(1);
    const list = vi.spyOn(manager, "list");
    await handle["zli:mobile:settings-set"]?.({ agentTools: false });
    expect(list).not.toHaveBeenCalled();
    await handle["zli:mobile:settings-set"]?.({ iosRemoteHost: "dev@studio.local" });
    expect(settings.set).toHaveBeenLastCalledWith({ iosRemoteHost: "dev@studio.local" });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("serves the proposal channels, which take only an id and parse every payload", async () => {
    const host = createTestDevHost();
    const dev = createMobileDev(host);
    const handle = mobileIpcHandlers({ service: () => undefined, settings: () => undefined, dev: () => dev });
    const proposal = host.proposals.create({
      worktreeId: "wt-1",
      source: "agent",
      sourceLabel: "Proposed by the agent in app",
      title: "Install packages",
      reason: "",
      action: { kind: "command", program: "npm", args: ["install"] },
    });
    expect(handle["zli:mobile:proposals:list"]?.({ worktreeId: "wt-1" })).toEqual([proposal]);
    expect(handle["zli:mobile:proposals:list"]?.(undefined)).toEqual([proposal]);
    expect(handle["zli:mobile:proposals:list"]?.({ worktreeId: "wt-2" })).toEqual([]);
    expect(() => handle["zli:mobile:proposals:accept"]?.({ proposalId: "not-an-id" })).toThrow();
    expect(() =>
      handle["zli:mobile:proposals:accept"]?.({ proposalId: proposal.proposalId, args: ["rm"] }),
    ).not.toThrow();
    await Promise.resolve();
    expect(host.commands.map((entry) => entry.command.args)).toEqual([["-lc", "'npm' 'install'"]]);
    expect(() => handle["zli:mobile:proposals:dismiss"]?.({})).toThrow();
  });

  it("refuses a dev channel that could replace a core one", () => {
    const dev = { ipc: { "zli:mobile:status": () => "replaced" } };
    expect(() => mobileIpcHandlers({ service: () => undefined, settings: () => undefined, dev: () => dev })).toThrow(
      /zli:mobile:<feature>:<verb>/u,
    );
  });

  it("parses simulator requests before they reach simctl", async () => {
    const { simulators, handle } = handlers();
    const input = {
      name: "Checkout iPhone",
      deviceTypeId: "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro",
      runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-18-2",
    };
    const udid = "5A3F2C1D-1111-4222-8333-944455556666";
    await handle["zli:mobile:sim-list"]?.(undefined);
    await handle["zli:mobile:sim-create"]?.(input);
    await handle["zli:mobile:sim-delete"]?.({ udid });
    expect(simulators.list).toHaveBeenCalledTimes(1);
    expect(simulators.create).toHaveBeenCalledWith(input);
    expect(simulators.delete).toHaveBeenCalledWith({ udid });
    expect(() => handle["zli:mobile:sim-create"]?.({ ...input, name: "-help" })).toThrow();
    expect(() => handle["zli:mobile:sim-create"]?.({ ...input, runtimeId: "iOS-18-2" })).toThrow();
    expect(() => handle["zli:mobile:sim-delete"]?.({ udid: "--all" })).toThrow();
    expect(simulators.create).toHaveBeenCalledTimes(1);
    expect(simulators.delete).toHaveBeenCalledTimes(1);
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
