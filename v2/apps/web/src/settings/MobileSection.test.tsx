// @vitest-environment jsdom

import type { MobileDevice, MobileSettings, MobileSetupStatus, MobileSimulatorCreateInput } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useDeviceFrame } from "../mobile/useDeviceFrame.js";
import type { MobileBridge, ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { MobileSection } from "./MobileSection.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const found = { found: true, path: "/sdk/tool", version: "35.0.2" };

const pixel: MobileDevice = {
  deviceId: "android-avd:Pixel_8",
  platform: "android",
  kind: "emulator",
  name: "Pixel_8",
  state: "shutdown",
  osVersion: "15",
  lease: null,
};

const phone: MobileDevice = {
  deviceId: "android:R5CT",
  platform: "android",
  kind: "physical",
  name: "Galaxy S24",
  state: "online",
  osVersion: "14",
  serial: "R5CT",
  lease: null,
};

function status(): MobileSetupStatus {
  return {
    host: { os: "windows", arch: "x64" },
    android: {
      sdkRoot: "C:\\Android\\Sdk",
      sdkSource: "env",
      adb: found,
      emulator: found,
      sdkmanager: { found: false },
      avdmanager: { found: false },
      java: { found: false },
      systemImages: ["system-images;android-35;google_apis;x86_64"],
      avds: ["Pixel_8"],
      acceleration: { checked: true, usable: false, detail: "Turn on Windows Hypervisor Platform." },
      missing: [],
    },
    ios: { supported: false, simctl: { found: false }, idb: { found: false }, missing: [] },
  };
}

function createMobile(devices: MobileDevice[]) {
  let settings: MobileSettings = { agentTools: true, crashWatch: true };
  const listeners = new Set<(next: MobileDevice[]) => void>();
  const mobile = {
    status: vi.fn(async (_options?: { recheckAcceleration?: boolean }) => status()),
    devices: vi.fn(async () => devices),
    onDevices: (listener: (next: MobileDevice[]) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    boot: vi.fn(async () => pixel),
    shutdown: vi.fn(async () => undefined),
    getSettings: vi.fn(async () => settings),
    setSettings: vi.fn(async (patch: Partial<MobileSettings>) => {
      settings = { ...settings, ...patch };
      return settings;
    }),
    testIosHost: vi.fn(async (_host: string) => ({
      ok: true,
      message: "Connected to mac-mini.local. Found 2 simulators.",
    })),
  };
  return {
    mobile,
    publish(next: MobileDevice[]) {
      for (const listener of listeners) listener(next);
    },
  };
}

function bridgeWith(mobile: unknown): ZliBridge {
  return {
    runtime: { getProjection: async () => undefined, onProjection: () => () => undefined },
    ...(mobile ? { mobile: mobile as MobileBridge } : {}),
  } as unknown as ZliBridge;
}

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  window.localStorage.clear();
});

function FrameProbe() {
  const [shown] = useDeviceFrame();
  return <output data-testid="frame">{shown ? "on" : "off"}</output>;
}

async function render(bridge: ZliBridge) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <RuntimeProvider bridge={bridge}>
        <MobileSection />
        <FrameProbe />
      </RuntimeProvider>,
    );
  });
  return container;
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.getAttribute("aria-label") === name || candidate.textContent?.trim() === name,
  );
  if (!match) throw new Error(`No button ${name}`);
  return match;
}

function switchFor(container: HTMLElement, label: string): HTMLInputElement {
  const row = [...container.querySelectorAll<HTMLLabelElement>(".switch-row")].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  const input = row?.querySelector<HTMLInputElement>("input");
  if (!input) throw new Error(`No switch ${label}`);
  return input;
}

describe("Settings > Mobile", () => {
  it("says the settings need the desktop app when there is no device bridge", async () => {
    const container = await render(bridgeWith(undefined));
    expect(container.textContent).toContain("in the ZLI desktop app only");
    expect(container.querySelector(".mobile-device-rows")).toBeNull();
  });

  it("lists devices by kind with their state, and boots or shuts down virtual ones", async () => {
    const fake = createMobile([phone, pixel]);
    const container = await render(bridgeWith(fake.mobile));
    const names = [...container.querySelectorAll(".mobile-device-name")].map((node) => node.textContent);
    expect(names).toEqual(["Pixel_8", "Galaxy S24"]);
    expect(container.querySelector(".mobile-device-row")?.textContent).toContain("Android Emulator, Android 15");
    // A USB phone has no Boot or Shut down: only the person holding it can turn it on.
    expect(container.querySelectorAll(".mobile-device-row")[1]?.querySelector("button")).toBeNull();

    await act(async () => button(container, "Boot Pixel_8").click());
    expect(fake.mobile.boot).toHaveBeenCalledWith("android-avd:Pixel_8");

    await act(async () => fake.publish([{ ...pixel, state: "online" }]));
    await act(async () => button(container, "Shut down Pixel_8").click());
    expect(fake.mobile.shutdown).toHaveBeenCalledWith("android-avd:Pixel_8");
  });

  it("shows how each phone is connected, what to do when it is not ready, and disconnects a Wi-Fi phone", async () => {
    const wifi: MobileDevice = {
      ...phone,
      deviceId: "android:192.168.1.20:39457",
      name: "Pixel 8 Pro",
      serial: "192.168.1.20:39457",
      connection: "wifi",
    };
    const waiting: MobileDevice = { ...phone, state: "unauthorized", connection: "usb", osVersion: undefined };
    const fake = createMobile([wifi, waiting]);
    const disconnectWifi = vi.fn(async (_deviceId: string) => undefined);
    const container = await render(bridgeWith({ ...fake.mobile, disconnectWifi }));
    const rows = [...container.querySelectorAll<HTMLElement>(".mobile-device-row")];
    expect(rows[0]?.textContent).toContain("Android phone, Android 14, Wi-Fi");
    expect(rows[0]?.textContent).toContain("Ready");
    expect(rows[1]?.textContent).toContain("Allow USB debugging on the phone, then check the prompt on its screen.");
    expect(rows[1]?.querySelector("button")).toBeNull();
    await act(async () => button(container, "Disconnect Pixel 8 Pro").click());
    expect(disconnectWifi).toHaveBeenCalledWith("android:192.168.1.20:39457");
  });

  it("shows where the SDK is, which tools are missing, and rechecks acceleration on request", async () => {
    const fake = createMobile([]);
    const container = await render(bridgeWith(fake.mobile));
    expect(container.textContent).toContain("No devices yet.");
    expect(container.textContent).toContain("C:\\Android\\Sdk");
    expect(container.textContent).toContain("Found through ANDROID_HOME.");
    const rows = [...container.querySelectorAll<HTMLElement>(".setting-row")];
    const row = (label: string) =>
      rows.find((candidate) => candidate.querySelector(".setting-label")?.textContent === label);
    expect(row("Platform tools")?.textContent).toContain("Installed");
    expect(row("Platform tools")?.textContent).toContain("35.0.2");
    expect(row("Java")?.textContent).toContain("Missing");
    expect(row("Hardware acceleration")?.textContent).toContain("Turn on Windows Hypervisor Platform.");
    expect(row("System images")?.textContent).toContain("API 35, Google APIs, x86_64");
    expect(row("Xcode")?.textContent).toContain("iPhone simulators need a Mac with Xcode.");

    await act(async () => button(container, "Check again").click());
    expect(fake.mobile.status).toHaveBeenLastCalledWith({ recheckAcceleration: true });
  });

  it("turns the device frame off for every view in the window, and remembers it", async () => {
    const container = await render(bridgeWith(createMobile([]).mobile));
    expect(container.querySelector("[data-testid=frame]")?.textContent).toBe("on");
    await act(async () => switchFor(container, "Show device frame").click());
    expect(container.querySelector("[data-testid=frame]")?.textContent).toBe("off");
    expect(window.localStorage.getItem("zli.mobile.skin.v1")).toBe("off");
  });

  it("saves the agent switch through the desktop app", async () => {
    const fake = createMobile([]);
    const container = await render(bridgeWith(fake.mobile));
    const agents = switchFor(container, "Let agents use devices");
    expect(agents.checked).toBe(true);
    await act(async () => agents.click());
    expect(fake.mobile.setSettings).toHaveBeenCalledWith({ agentTools: false });
  });

  it("creates a simulator from New device and shows it in the list", async () => {
    const simulator: MobileDevice = {
      deviceId: "ios:5A3F2C1D-1111-4222-8333-944455556666",
      platform: "ios",
      kind: "simulator",
      name: "iPhone 16",
      state: "shutdown",
      osVersion: "18.2",
      lease: null,
    };
    const devices: MobileDevice[] = [pixel];
    const fake = createMobile(devices);
    const mobile = withCreate(fake.mobile, devices);
    const container = await render(bridgeWith(mobile));
    await act(async () => button(container, "New device…").click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="New device"]');
    expect(dialog?.querySelector('[role="radiogroup"]')?.textContent).toBe("Android emulatoriPhone simulator");
    const radios = [...document.querySelectorAll<HTMLInputElement>('[role="radiogroup"] input')];
    await act(async () => radios[1]?.click());
    const name = document.querySelector<HTMLInputElement>(".new-device-form .field input");
    expect(name?.value).toBe("iPhone 16");

    mobile.createSimulator.mockImplementationOnce(async (input) => {
      devices.push({ ...simulator, name: input.name });
      return { deviceId: simulator.deviceId, name: input.name };
    });
    await act(async () => button(document.body, "Create").click());
    expect(mobile.createSimulator).toHaveBeenCalledWith({
      name: "iPhone 16",
      deviceTypeId: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
      runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-18-2",
    });
    expect(document.querySelector('[role="dialog"][aria-label="New device"]')).toBeNull();
    expect([...container.querySelectorAll(".mobile-device-name")].map((node) => node.textContent)).toEqual([
      "Pixel_8",
      "iPhone 16",
    ]);
    expect(container.textContent).toContain("Created iPhone 16.");
  });

  it("offers an iPhone simulator on Windows when a Mac is set over SSH", async () => {
    const devices: MobileDevice[] = [pixel];
    const fake = createMobile(devices);
    const mobile = withCreate(fake.mobile, devices);
    const remote = await mobile.status();
    remote.host = { os: "windows", arch: "x64" };
    remote.ios = { ...remote.ios, host: "me@mac-mini.local" };
    mobile.status.mockResolvedValue(remote);
    const container = await render(bridgeWith(mobile));
    await act(async () => button(container, "New device…").click());
    const radios = [...document.querySelectorAll<HTMLInputElement>('[role="radiogroup"] input')];
    expect(radios.map((radio) => radio.parentElement?.textContent)).toEqual(["Android emulator", "iPhone simulator"]);
    await act(async () => radios[1]?.click());
    expect(mobile.listSimulators).toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>(".new-device-form .field input")?.value).toBe("iPhone 16");
  });

  it("deletes a shut down simulator or emulator only after asking in its row", async () => {
    const simulator: MobileDevice = {
      deviceId: "ios:5A3F2C1D-1111-4222-8333-944455556666",
      platform: "ios",
      kind: "simulator",
      name: "iPhone 16",
      state: "shutdown",
      lease: null,
    };
    const running: MobileDevice = {
      ...simulator,
      deviceId: "ios:6B4E3D2C-1111-4222-8333-944455556666",
      name: "Busy",
      state: "online",
    };
    const devices: MobileDevice[] = [pixel, phone, simulator, running];
    const fake = createMobile(devices);
    const mobile = withCreate(fake.mobile, devices);
    const container = await render(bridgeWith(mobile));
    expect(() => button(container, "Delete Busy")).toThrow();
    expect(() => button(container, "Delete Galaxy S24")).toThrow();

    await act(async () => button(container, "Delete iPhone 16").click());
    expect(mobile.deleteSimulator).not.toHaveBeenCalled();
    expect(container.querySelector('fieldset[aria-label="Delete iPhone 16?"]')?.textContent).toContain(
      "Delete it and its data?",
    );
    await act(async () => button(container, "Keep it").click());
    expect(container.querySelector('fieldset[aria-label="Delete iPhone 16?"]')).toBeNull();

    await act(async () => button(container, "Delete iPhone 16").click());
    await act(async () => button(container, "Delete iPhone 16 for good").click());
    expect(mobile.deleteSimulator).toHaveBeenCalledWith("5A3F2C1D-1111-4222-8333-944455556666");
    expect(container.textContent).toContain("Deleted iPhone 16.");

    await act(async () => button(container, "Delete Pixel_8").click());
    mobile.deleteAvd.mockRejectedValueOnce(new Error("Shut down Pixel 8 before deleting it."));
    await act(async () => button(container, "Delete Pixel_8 for good").click());
    expect(mobile.deleteAvd).toHaveBeenCalledWith("Pixel_8");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Shut down Pixel 8 before deleting it.");
    expect(container.querySelector('fieldset[aria-label="Delete Pixel_8?"]')).toBeNull();
  });

  it("saves, tests, and clears the Mac that runs iPhone simulators", async () => {
    const fake = createMobile([]);
    const container = await render(bridgeWith(fake.mobile));
    const input = container.querySelector<HTMLInputElement>('input[placeholder="you@mac-mini.local"]');
    if (!input) throw new Error("No Mac address field");
    const type = (value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };

    await act(async () => type("me@bad host"));
    expect(container.textContent).toContain("Test connection");
    expect(button(container, "Save").disabled).toBe(true);

    await act(async () => type("  me@mac-mini.local "));
    await act(async () => button(container, "Save").click());
    expect(fake.mobile.setSettings).toHaveBeenCalledWith({ iosRemoteHost: "me@mac-mini.local" });
    expect(container.textContent).toContain("ZLI runs iPhone simulators on mac-mini.local over SSH.");

    await act(async () => button(container, "Test connection").click());
    expect(fake.mobile.testIosHost).toHaveBeenCalledWith("me@mac-mini.local");
    expect([...container.querySelectorAll("[role=status]")].map((node) => node.textContent).filter(Boolean)).toEqual([
      "Connected to mac-mini.local. Found 2 simulators.",
    ]);

    await act(async () => button(container, "Clear the Mac").click());
    expect(fake.mobile.setSettings).toHaveBeenLastCalledWith({ iosRemoteHost: "" });
    expect(input.value).toBe("");
    expect(container.textContent).not.toContain("Test connection");
  });
});

/** A Mac with avdmanager and Xcode, so New device offers both platforms and Delete shows for virtual devices. */
function withCreate(mobile: ReturnType<typeof createMobile>["mobile"], devices: MobileDevice[]) {
  const ready = status();
  ready.host = { os: "macos", arch: "arm64" };
  ready.android.avdmanager = found;
  ready.ios = { supported: true, simctl: found, idb: found, missing: [] };
  const avds = {
    avdmanager: true,
    avds: [{ name: "Pixel_8", displayName: "Pixel 8" }],
    systemImages: ["system-images;android-35;google_apis;arm64-v8a"],
    deviceProfiles: [{ id: "pixel_7", name: "Pixel 7" }],
    defaultDeviceProfile: "pixel_7",
  };
  return {
    ...mobile,
    status: vi.fn(async () => ready),
    listAvds: vi.fn(async () => avds),
    createAvd: vi.fn(async () => avds),
    deleteAvd: vi.fn(async (name: string) => {
      devices.splice(
        devices.findIndex((device) => device.deviceId === `android-avd:${name}`),
        1,
      );
      return avds;
    }),
    listSimulators: vi.fn(async () => ({
      simctl: true,
      deviceTypes: [
        { id: "com.apple.CoreSimulator.SimDeviceType.iPhone-16", name: "iPhone 16", family: "iPhone" as const },
      ],
      runtimes: [
        {
          id: "com.apple.CoreSimulator.SimRuntime.iOS-18-2",
          name: "iOS 18.2",
          version: "18.2",
          deviceTypeIds: ["com.apple.CoreSimulator.SimDeviceType.iPhone-16"],
        },
      ],
    })),
    createSimulator: vi.fn(async (input: MobileSimulatorCreateInput) => ({ deviceId: "ios:NEW", name: input.name })),
    deleteSimulator: vi.fn(async (udid: string) => {
      devices.splice(
        devices.findIndex((device) => device.deviceId === `ios:${udid}`),
        1,
      );
    }),
  };
}
