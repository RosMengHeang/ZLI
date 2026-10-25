// @vitest-environment jsdom

import type {
  MobileDevice,
  MobileSettings,
  MobileSetupPlan,
  MobileSetupProgress,
  MobileSetupStatus,
  MobileStreamEvent,
} from "@zli-v2/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { MobileBridge, ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { MobilePane, type MobileReveal } from "./MobilePane.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const emulator: MobileDevice = {
  deviceId: "android-avd:Pixel_8",
  platform: "android",
  kind: "emulator",
  name: "Pixel 8",
  state: "online",
  osVersion: "15",
  serial: "emulator-5554",
  lease: null,
};

const probe = { found: true, path: "/sdk/tool" };

function readyStatus(): MobileSetupStatus {
  return {
    host: { os: "linux", arch: "x64" },
    android: {
      sdkRoot: "/sdk",
      sdkSource: "env",
      adb: probe,
      emulator: probe,
      sdkmanager: probe,
      avdmanager: probe,
      java: probe,
      systemImages: ["system-images;android-35;google_apis;x86_64"],
      avds: ["Pixel_8"],
      acceleration: { checked: true, usable: true, detail: "" },
      missing: [],
    },
    ios: { supported: false, simctl: { found: false }, idb: { found: false }, missing: ["A Mac with Xcode"] },
  };
}

function emptyStatus(): MobileSetupStatus {
  const status = readyStatus();
  return {
    ...status,
    android: {
      ...status.android,
      sdkSource: "none",
      adb: { found: false },
      emulator: { found: false },
      sdkmanager: { found: false },
      avdmanager: { found: false },
      java: { found: false },
      systemImages: [],
      avds: [],
      acceleration: { checked: true, usable: false, detail: "KVM is not available. Turn on virtualization." },
      missing: ["Android platform tools (adb)", "Android Emulator", "Hardware acceleration for the emulator"],
    },
  };
}

const plan: MobileSetupPlan = {
  sdkRoot: "/home/me/.zli/android-sdk",
  steps: [
    { id: "platform-tools", label: "Android platform tools", bytes: 7 * 1024 * 1024 },
    { id: "emulator", label: "Android Emulator", bytes: 300 * 1024 * 1024 },
  ],
  licenses: [{ id: "android-sdk-license", title: "Android SDK License", text: "Terms and conditions" }],
  systemImage: "system-images;android-35;google_apis;x86_64",
  avdName: "ZLI_Pixel",
};

function createMobile(options: { devices: MobileDevice[]; status?: MobileSetupStatus }) {
  let devices = options.devices;
  let settings: MobileSettings = { agentTools: true };
  const deviceListeners = new Set<(next: MobileDevice[]) => void>();
  const streamListeners = new Set<(event: MobileStreamEvent) => void>();
  const setupListeners = new Set<(progress: MobileSetupProgress) => void>();
  let finishSetup: (() => void) | undefined;
  const mobile = {
    status: vi.fn(async () => options.status ?? readyStatus()),
    setupPlan: vi.fn(async () => plan),
    setupProgress: vi.fn(async (): Promise<MobileSetupProgress> => ({ state: "idle", message: "" })),
    runSetup: vi.fn(
      (_accepted: readonly string[]) =>
        new Promise<void>((resolve) => {
          finishSetup = resolve;
        }),
    ),
    cancelSetup: vi.fn(async () => undefined),
    onSetupProgress: (listener: (progress: MobileSetupProgress) => void) => {
      setupListeners.add(listener);
      return () => setupListeners.delete(listener);
    },
    devices: vi.fn(async () => devices),
    onDevices: (listener: (next: MobileDevice[]) => void) => {
      deviceListeners.add(listener);
      return () => deviceListeners.delete(listener);
    },
    boot: vi.fn(async (deviceId: string) => devices.find((device) => device.deviceId === deviceId) as MobileDevice),
    shutdown: vi.fn(async () => undefined),
    startStream: vi.fn(async (deviceId: string) => ({ deviceId, mode: "stills" as const, width: 0, height: 0 })),
    stopStream: vi.fn(async () => undefined),
    onStream: (listener: (event: MobileStreamEvent) => void) => {
      streamListeners.add(listener);
      return () => streamListeners.delete(listener);
    },
    input: vi.fn(async () => undefined),
    takeOver: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => ({ data: pixel, mimeType: "image/png" as const, width: 1080, height: 2400 })),
    getSettings: vi.fn(async () => settings),
    setSettings: vi.fn(async (patch: Partial<MobileSettings>) => {
      settings = { ...settings, ...patch };
      return settings;
    }),
    onReveal: () => () => undefined,
  } satisfies MobileBridge;
  return {
    mobile,
    publishDevices(next: MobileDevice[]) {
      devices = next;
      for (const listener of deviceListeners) listener(next);
    },
    stream(event: MobileStreamEvent) {
      for (const listener of streamListeners) listener(event);
    },
    progress(progress: MobileSetupProgress) {
      for (const listener of setupListeners) listener(progress);
    },
    finishSetup: () => finishSetup?.(),
  };
}

function bridgeWith(mobile: MobileBridge | undefined): ZliBridge {
  return {
    runtime: { getProjection: async () => undefined, onProjection: () => () => undefined },
    ...(mobile ? { mobile } : {}),
  } as unknown as ZliBridge;
}

let root: Root | undefined;

beforeAll(() => {
  HTMLElement.prototype.setPointerCapture ??= () => undefined;
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  window.localStorage.clear();
});

async function render(bridge: ZliBridge, reveal?: MobileReveal) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <RuntimeProvider bridge={bridge}>
        <MobilePane reveal={reveal} />
      </RuntimeProvider>,
    );
  });
  return container;
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === name || candidate.getAttribute("aria-label") === name,
  );
  if (!found) throw new Error(`No button ${name}`);
  return found;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}

function pointer(element: Element, type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
  Object.defineProperty(event, "pointerId", { value: 1 });
  element.dispatchEvent(event);
}

describe("MobilePane", () => {
  it("explains that devices need the desktop app when the bridge has no mobile service", async () => {
    const container = await render(bridgeWith(undefined));
    expect(container.textContent).toContain("Devices need the desktop app");
  });

  it("shows a running device and sends taps and keys in device pixels", async () => {
    const fake = createMobile({ devices: [emulator] });
    const container = await render(bridgeWith(fake.mobile));
    expect(fake.mobile.startStream).toHaveBeenCalledWith(emulator.deviceId);
    expect(container.textContent).toContain("Connecting to Pixel 8");

    await act(async () => {
      fake.stream({ type: "still", deviceId: emulator.deviceId, data: pixel, width: 1080, height: 2400 });
    });
    const screen = container.querySelector<HTMLImageElement>("img.mobile-screen");
    expect(screen).not.toBeNull();
    if (!screen) return;
    screen.getBoundingClientRect = () => ({ left: 0, top: 0, width: 270, height: 600 }) as DOMRect;

    await act(async () => {
      pointer(screen, "pointerdown", 135, 300);
      pointer(screen, "pointerup", 135, 300);
    });
    expect(fake.mobile.input).toHaveBeenCalledWith({
      deviceId: emulator.deviceId,
      type: "touch",
      action: "down",
      x: 540,
      y: 1200,
    });
    expect(fake.mobile.input).toHaveBeenCalledWith({
      deviceId: emulator.deviceId,
      type: "touch",
      action: "up",
      x: 540,
      y: 1200,
    });

    await act(async () => {
      screen.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    });
    expect(fake.mobile.input).toHaveBeenLastCalledWith({ deviceId: emulator.deviceId, type: "text", text: "a" });

    await click(button(container, "Back"));
    expect(fake.mobile.input).toHaveBeenLastCalledWith({ deviceId: emulator.deviceId, type: "button", button: "back" });
  });

  it("blocks input while an agent holds the device and hands control over on request", async () => {
    const held: MobileDevice = {
      ...emulator,
      lease: { ownerId: "s1", ownerLabel: "Codex", kind: "agent", acquiredAt: "2025-01-01T00:00:00.000Z" },
    };
    const fake = createMobile({ devices: [held] });
    const container = await render(bridgeWith(fake.mobile));
    expect(container.textContent).toContain("Codex is using this device. Take over to use it yourself.");

    await click(button(container, "Home"));
    expect(fake.mobile.input).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button(container, "Take over"));

    await click(button(container, "Take over"));
    expect(fake.mobile.takeOver).toHaveBeenCalledWith(held.deviceId);

    await act(async () => {
      fake.publishDevices([
        {
          ...emulator,
          lease: { ownerId: "person", ownerLabel: "You", kind: "person", acquiredAt: "2025-01-01T00:00:00.000Z" },
        },
      ]);
    });
    expect(container.textContent).toContain("You have control.");
    await click(button(container, "Hand back to agents"));
    expect(fake.mobile.release).toHaveBeenCalledWith(held.deviceId);
  });

  it("boots a device that is off and follows the list as it starts", async () => {
    const off: MobileDevice = { ...emulator, state: "shutdown", serial: undefined };
    const fake = createMobile({ devices: [off] });
    const container = await render(bridgeWith(fake.mobile));
    expect(container.textContent).toContain("Pixel 8 is off");

    await click(container.querySelector<HTMLButtonElement>(".empty-state-actions button") as HTMLButtonElement);
    expect(fake.mobile.boot).toHaveBeenCalledWith(off.deviceId);

    await act(async () => {
      fake.publishDevices([{ ...off, state: "booting" }]);
    });
    expect(container.textContent).toContain("Booting Pixel 8");
    expect(fake.mobile.startStream).not.toHaveBeenCalled();

    await act(async () => {
      fake.publishDevices([emulator]);
    });
    expect(fake.mobile.startStream).toHaveBeenCalledWith(emulator.deviceId);
  });

  it("selects the device an agent revealed", async () => {
    const second: MobileDevice = { ...emulator, deviceId: "android:R5CT", kind: "physical", name: "Galaxy S23" };
    const fake = createMobile({ devices: [emulator, second] });
    const container = await render(bridgeWith(fake.mobile), { deviceId: second.deviceId, key: 1 });
    expect(container.querySelector(".picker-trigger-label")?.textContent).toBe("Galaxy S23");
    expect(fake.mobile.startStream).toHaveBeenLastCalledWith(second.deviceId);
    expect(window.localStorage.getItem("zli.mobile.device.v1")).toBe(second.deviceId);
  });

  it("turns the agent tools off from the panel", async () => {
    const fake = createMobile({ devices: [emulator] });
    const container = await render(bridgeWith(fake.mobile));
    const toggle = container.querySelector<HTMLInputElement>('input[role="switch"]');
    expect(toggle?.checked).toBe(true);
    await click(toggle as HTMLInputElement);
    expect(fake.mobile.setSettings).toHaveBeenCalledWith({ agentTools: false });
    expect(toggle?.checked).toBe(false);
  });

  it("walks through Android setup: review, accept the license, install, and follow progress", async () => {
    const fake = createMobile({ devices: [], status: emptyStatus() });
    const container = await render(bridgeWith(fake.mobile));
    expect(container.textContent).toContain("KVM is not available. Turn on virtualization.");
    expect(container.textContent).toContain("Android platform tools (adb)");
    expect(container.textContent).not.toContain("- Hardware acceleration");
    expect(container.textContent).toContain("iPhone simulators need a Mac with Xcode.");

    await click(button(container, "Review the install"));
    expect(container.textContent).toContain("/home/me/.zli/android-sdk");
    expect(container.textContent).toContain("about 307 MB");
    const install = button(container, "Install");
    expect(install.disabled).toBe(true);

    await click(
      container.querySelector<HTMLInputElement>('.mobile-license input[type="checkbox"]') as HTMLInputElement,
    );
    expect(install.disabled).toBe(false);
    await click(install);
    expect(fake.mobile.runSetup).toHaveBeenCalledWith(["android-sdk-license"]);

    await act(async () => {
      fake.progress({
        state: "running",
        stepId: "emulator",
        message: "Downloading the Android Emulator",
        receivedBytes: 150 * 1024 * 1024,
        totalBytes: 300 * 1024 * 1024,
      });
    });
    expect(container.textContent).toContain("Downloading the Android Emulator");
    expect(container.textContent).toContain("150 MB of 300 MB");
    expect(container.querySelector<HTMLProgressElement>("progress")?.value).toBe(50);

    await click(button(container, "Cancel"));
    expect(fake.mobile.cancelSetup).toHaveBeenCalled();

    fake.mobile.status.mockResolvedValue(readyStatus());
    await act(async () => {
      fake.progress({ state: "done", message: "Android is ready. Boot the virtual device to start." });
      fake.finishSetup();
    });
    expect(fake.mobile.status).toHaveBeenCalledTimes(2);

    await act(async () => {
      fake.publishDevices([{ ...emulator, state: "shutdown" }]);
    });
    expect(container.textContent).toContain("Pixel 8 is off");
  });

  it("leads a Windows host with one Android card and keeps iOS to a single line", async () => {
    const status = emptyStatus();
    const fake = createMobile({ devices: [], status: { ...status, host: { os: "windows", arch: "x64" } } });
    const container = await render(bridgeWith(fake.mobile));
    expect(headings(container)).toEqual(["Set up the Android emulator"]);
    expect(container.querySelector(".mobile-setup-card")?.textContent).toContain("Android Emulator");
    expect(container.textContent).toContain("Or connect an Android phone with USB debugging turned on.");
    expect(container.querySelector(".mobile-setup-ios-note")?.textContent).toBe(
      "iPhone simulators need a Mac with Xcode.",
    );

    const primary = [...container.querySelectorAll<HTMLButtonElement>(".mobile-setup-card .btn-primary")];
    expect(primary.map((candidate) => candidate.textContent)).toEqual(["Review the install"]);
    await click(primary[0] as HTMLButtonElement);
    expect(fake.mobile.setupPlan).toHaveBeenCalled();
    expect(container.textContent).toContain("I accept the Android SDK License");
    expect(container.textContent).toContain("about 307 MB");
  });

  it("shows Android and iOS side by side on a Mac", async () => {
    const status = emptyStatus();
    const fake = createMobile({
      devices: [],
      status: {
        ...status,
        host: { os: "macos", arch: "arm64" },
        ios: { supported: true, simctl: probe, idb: { found: false }, missing: ["idb, for taps and typing"] },
      },
    });
    const container = await render(bridgeWith(fake.mobile));
    expect(headings(container)).toEqual(["Set up the Android emulator", "iOS"]);
    expect(container.textContent).toContain("idb, for taps and typing");
    expect(container.querySelector(".mobile-setup-ios-note")).toBeNull();
  });

  it("offers to create a virtual device when the SDK has none", async () => {
    const ready = readyStatus();
    const fake = createMobile({ devices: [], status: { ...ready, android: { ...ready.android, avds: [] } } });
    const container = await render(bridgeWith(fake.mobile));
    expect(headings(container)).toEqual(["Create an Android virtual device"]);
    expect(container.textContent).not.toContain("Android Studio");
    await click(button(container, "Review and create"));
    expect(fake.mobile.setupPlan).toHaveBeenCalled();
  });

  it("asks for a refresh, not Android Studio, when the SDK is ready but nothing is listed", async () => {
    const fake = createMobile({ devices: [] });
    const container = await render(bridgeWith(fake.mobile));
    expect(container.textContent).toContain("No devices found");
    expect(container.textContent).not.toContain("Android Studio");
    expect(container.querySelector(".mobile-empty-note")?.textContent).toContain("ZLI uses the SDK in /sdk.");
    expect(container.querySelector(".mobile-empty-note")?.textContent).toContain("ANDROID_HOME");
    await click(button(container, "Refresh"));
    expect(fake.mobile.devices).toHaveBeenCalledTimes(2);
  });
});

function headings(container: HTMLElement): string[] {
  return [...container.querySelectorAll("h3")].map((heading) => heading.textContent ?? "");
}
