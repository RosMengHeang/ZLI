// @vitest-environment jsdom

import type { MobileDevice, MobileSettings, MobileSetupStatus } from "@zli-v2/contracts";
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
  let settings: MobileSettings = { agentTools: true };
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
});
