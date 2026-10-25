// @vitest-environment jsdom

import type {
  MobileDevice,
  MobilePanelInput,
  MobileSettings,
  MobileSetupPlan,
  MobileSetupProgress,
  MobileSetupStatus,
  MobileStreamEvent,
  MobileStreamInfo,
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
    startStream: vi.fn(
      async (deviceId: string): Promise<MobileStreamInfo> => ({ deviceId, mode: "stills", width: 0, height: 0 }),
    ),
    stopStream: vi.fn(async () => undefined),
    onStream: (listener: (event: MobileStreamEvent) => void) => {
      streamListeners.add(listener);
      return () => streamListeners.delete(listener);
    },
    input: vi.fn(async (_input: MobilePanelInput) => undefined),
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
  vi.useRealTimers();
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

function wheel(element: Element, deltaY: number, x: number, y: number) {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY, clientX: x, clientY: y });
  element.dispatchEvent(event);
  return event;
}

async function showStill(fake: ReturnType<typeof createMobile>, device: MobileDevice) {
  await act(async () => {
    fake.stream({ type: "still", deviceId: device.deviceId, data: pixel, width: 1080, height: 2400 });
  });
}

function sizedScreen(container: HTMLElement): HTMLImageElement {
  const screen = container.querySelector<HTMLImageElement>("img.mobile-screen");
  if (!screen) throw new Error("No screen");
  screen.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 270, bottom: 600, width: 270, height: 600 }) as DOMRect;
  return screen;
}

function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function paste(element: Element, text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
  element.dispatchEvent(event);
  return event;
}

function texts(fake: ReturnType<typeof createMobile>) {
  return fake.mobile.input.mock.calls.flatMap(([input]) => (input.type === "text" ? [input.text] : []));
}

async function advance(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

function touches(fake: ReturnType<typeof createMobile>) {
  return fake.mobile.input.mock.calls.flatMap(([input]) =>
    input.type === "touch" ? [`${input.action} ${input.x},${input.y}`] : [],
  );
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

    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    await act(async () => {
      screen.dispatchEvent(tab);
    });
    expect(tab.defaultPrevented).toBe(true);
    expect(fake.mobile.input).toHaveBeenLastCalledWith({ deviceId: emulator.deviceId, type: "button", button: "tab" });
    const shiftTab = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    await act(async () => {
      screen.dispatchEvent(shiftTab);
    });
    expect(shiftTab.defaultPrevented).toBe(false);

    await click(button(container, "Back"));
    expect(fake.mobile.input).toHaveBeenLastCalledWith({ deviceId: emulator.deviceId, type: "button", button: "back" });
  });

  it("scrolls with the mouse wheel as one press and release in screenshot mode", async () => {
    vi.useFakeTimers();
    const fake = createMobile({ devices: [emulator] });
    const container = await render(bridgeWith(fake.mobile));
    await showStill(fake, emulator);
    const screen = sizedScreen(container);

    let event: WheelEvent | undefined;
    await act(async () => {
      event = wheel(screen, 60, 135, 300);
      wheel(screen, 40, 135, 300);
    });
    expect(event?.defaultPrevented).toBe(true);
    expect(fake.mobile.input).not.toHaveBeenCalled();
    await advance(1_000);
    expect(touches(fake)).toEqual(["down 540,1200", "up 540,800"]);
  });

  it("sends wheel swipes with moves when scrcpy carries input, in its own frame size", async () => {
    vi.useFakeTimers();
    const fake = createMobile({ devices: [emulator] });
    fake.mobile.startStream.mockImplementation(async (deviceId: string) => ({
      deviceId,
      mode: "video" as const,
      width: 540,
      height: 1200,
    }));
    const container = await render(bridgeWith(fake.mobile));
    // Without WebCodecs the panel shows screenshots, while touches still go through scrcpy.
    await act(async () => {
      fake.stream({ type: "config", deviceId: emulator.deviceId, codec: "avc1.42c028", width: 540, height: 1200 });
    });
    await advance(0);
    const screen = sizedScreen(container);
    await act(async () => {
      wheel(screen, 100, 135, 300);
    });
    await advance(1_000);
    expect(touches(fake)).toEqual([
      "down 270,600",
      "move 270,550",
      "move 270,500",
      "move 270,450",
      "move 270,400",
      "up 270,400",
    ]);
  });

  it("draws a trail while dragging in screenshot mode and sends only the press and release", async () => {
    const fake = createMobile({ devices: [emulator] });
    const container = await render(bridgeWith(fake.mobile));
    await showStill(fake, emulator);
    const screen = sizedScreen(container);

    await act(async () => {
      pointer(screen, "pointerdown", 135, 500);
    });
    expect(container.querySelector(".mobile-trail")).not.toBeNull();
    await act(async () => {
      pointer(screen, "pointermove", 135, 200);
    });
    const line = container.querySelector(".mobile-trail-line");
    expect([line?.getAttribute("y1"), line?.getAttribute("y2")]).toEqual(["500", "200"]);
    await act(async () => {
      pointer(screen, "pointermove", 135, -40);
    });
    expect(container.querySelector(".mobile-trail-end")?.getAttribute("cy")).toBe("0");
    await act(async () => {
      pointer(screen, "pointerup", 135, 200);
    });
    expect(container.querySelector(".mobile-trail")).toBeNull();
    expect(touches(fake)).toEqual(["down 540,2000", "up 540,800"]);
  });

  it("types text from the Type text field in 300-character pieces", async () => {
    const fake = createMobile({ devices: [emulator] });
    const container = await render(bridgeWith(fake.mobile));
    await click(button(container, "Type text"));
    const field = container.querySelector<HTMLInputElement>(".mobile-type-row input");
    if (!field) throw new Error("No Type text field");
    expect(document.activeElement).toBe(field);

    let finish: (() => void) | undefined;
    fake.mobile.input.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finish = () => resolve(undefined);
        }),
    );
    const long = `${"a".repeat(300)}${"b".repeat(300)}cd`;
    await act(async () => typeInto(field, long));
    await click(button(container, "Send"));
    expect(button(container, "Send").getAttribute("aria-busy")).toBe("true");
    await act(async () => finish?.());
    expect(texts(fake)).toEqual(["a".repeat(300), "b".repeat(300), "cd"]);
    expect(field.value).toBe("");

    fake.mobile.input.mockRejectedValueOnce(
      new Error("Error invoking remote method 'zli:mobile:input': Error: adb can type only printable ASCII."),
    );
    await act(async () => typeInto(field, "é"));
    await click(button(container, "Send"));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("adb can type only printable ASCII.");
    expect(field.value).toBe("é");

    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(container.querySelector(".mobile-type-row")).toBeNull();
    expect(document.activeElement).toBe(button(container, "Type text"));
  });

  it("pastes clipboard text into the device, through the paste event or the clipboard", async () => {
    vi.useFakeTimers();
    const readText = vi.fn(async () => "from the clipboard");
    Object.defineProperty(navigator, "clipboard", { value: { readText }, configurable: true });
    const fake = createMobile({ devices: [emulator] });
    const container = await render(bridgeWith(fake.mobile));
    await showStill(fake, emulator);
    const screen = sizedScreen(container);

    await act(async () => {
      screen.dispatchEvent(new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true }));
      expect(paste(screen, "x".repeat(320)).defaultPrevented).toBe(true);
    });
    await advance(200);
    expect(texts(fake)).toEqual(["x".repeat(300), "x".repeat(20)]);
    expect(readText).not.toHaveBeenCalled();

    await act(async () => {
      screen.dispatchEvent(new KeyboardEvent("keydown", { key: "v", metaKey: true, bubbles: true, cancelable: true }));
    });
    await advance(200);
    expect(readText).toHaveBeenCalledTimes(1);
    expect(texts(fake).at(-1)).toBe("from the clipboard");
    Reflect.deleteProperty(navigator, "clipboard");
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

    await showStill(fake, held);
    const screen = sizedScreen(container);
    (document.activeElement as HTMLElement).blur();
    let scrolled: WheelEvent | undefined;
    await act(async () => {
      scrolled = wheel(screen, 100, 135, 300);
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(scrolled?.defaultPrevented).toBe(true);
    expect(fake.mobile.input).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button(container, "Take over"));

    (document.activeElement as HTMLElement).blur();
    await act(async () => {
      paste(screen, "secret");
    });
    expect(document.activeElement).toBe(button(container, "Take over"));
    await click(button(container, "Type text"));
    const field = container.querySelector<HTMLInputElement>(".mobile-type-row input") as HTMLInputElement;
    await act(async () => typeInto(field, "hello"));
    await click(button(container, "Send"));
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

  it("shows when the agent's lease ends, counts down, and clears when the list says it lapsed", async () => {
    vi.useFakeTimers();
    const expiresAt = new Date(Date.now() + 3 * 60_000).toISOString();
    const held: MobileDevice = {
      ...emulator,
      lease: { ownerId: "s1", ownerLabel: "Claude", kind: "agent", acquiredAt: new Date().toISOString(), expiresAt },
    };
    const fake = createMobile({ devices: [held] });
    const container = await render(bridgeWith(fake.mobile));
    const banner = () => container.querySelector(".banner[role=status]")?.textContent ?? "";
    expect(banner()).toMatch(/^Claude is using this device until .+\. Take over to use it yourself\.Take over$/u);

    await advance(90_000);
    expect(banner()).toContain("Claude is using this device for about 2 more minutes.");

    await act(async () => {
      fake.publishDevices([emulator]);
    });
    expect(banner()).toBe("");
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

  it("counts the boot time, notes a slow boot, and cancels without reporting the stopped boot as a failure", async () => {
    vi.useFakeTimers();
    const off: MobileDevice = { ...emulator, state: "shutdown", serial: undefined };
    const fake = createMobile({ devices: [off] });
    let failBoot: ((cause: Error) => void) | undefined;
    fake.mobile.boot.mockImplementation(
      () =>
        new Promise<MobileDevice>((_resolve, reject) => {
          failBoot = reject;
        }),
    );
    fake.mobile.shutdown.mockImplementation(async () => {
      failBoot?.(new Error("Booting Pixel 8 was cancelled."));
    });
    const container = await render(bridgeWith(fake.mobile));
    await click(button(container, "Boot"));
    await act(async () => {
      fake.publishDevices([{ ...off, state: "booting" }]);
    });
    expect(container.querySelector(".empty-state-title")?.textContent).toBe("Booting Pixel 8, 0:00");
    expect(container.querySelector(".mobile-toolbar .badge")?.textContent).toBe("Booting 0:00");
    expect(container.textContent).toContain("The first boot of a new virtual device can take a few minutes.");

    await advance(42_000);
    expect(container.querySelector(".empty-state-title")?.textContent).toBe("Booting Pixel 8, 0:42");
    expect(container.textContent).not.toContain("taking longer than usual");
    await advance(3 * 60_000);
    expect(container.textContent).toContain("Open Setup to check that the emulator can use hardware acceleration.");

    await click(button(container, "Cancel"));
    expect(fake.mobile.shutdown).toHaveBeenCalledWith(off.deviceId);
    await act(async () => {
      fake.publishDevices([off]);
    });
    expect(container.textContent).toContain("Pixel 8 is off");
    expect(container.querySelector("[role=alert]")).toBeNull();
  });

  it("reports a cancel that could not stop the boot", async () => {
    const fake = createMobile({ devices: [{ ...emulator, state: "booting" }] });
    fake.mobile.shutdown.mockRejectedValueOnce(new Error("The emulator for Pixel 8 could not be stopped."));
    const container = await render(bridgeWith(fake.mobile));
    await click(button(container, "Cancel"));
    expect(container.querySelector("[role=alert]")?.textContent).toBe("The emulator for Pixel 8 could not be stopped.");
  });

  it("labels the screen Live for video and Screenshots with the reason otherwise", async () => {
    const fake = createMobile({ devices: [emulator] });
    fake.mobile.startStream.mockResolvedValueOnce({
      deviceId: emulator.deviceId,
      mode: "video",
      width: 1080,
      height: 2400,
    });
    const container = await render(bridgeWith(fake.mobile));
    expect(container.querySelector(".mobile-mode-chip")?.textContent).toBe("Live");

    await act(async () => {
      fake.stream({
        type: "info",
        info: {
          deviceId: emulator.deviceId,
          mode: "stills",
          width: 0,
          height: 0,
          fallbackReason: "scrcpy could not start.",
        },
      });
    });
    const chip = container.querySelector(".mobile-mode-chip");
    expect(chip?.textContent).toBe("Screenshots, about 1 per second");
    expect(chip?.getAttribute("title")).toBe("scrcpy could not start.");
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
