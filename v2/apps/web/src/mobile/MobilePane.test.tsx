// @vitest-environment jsdom

import type {
  MobileAvdCreateInput,
  MobileAvdList,
  MobileDevice,
  MobilePanelInput,
  MobilePopOut,
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
import type { DevServerHint } from "./mobile.js";
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

function avdListFor(status: MobileSetupStatus): MobileAvdList {
  return {
    avdmanager: status.android.avdmanager.found,
    avds: status.android.avds.map((name) => ({
      name,
      displayName: name.replaceAll("_", " "),
      systemImage: "system-images;android-35;google_apis;x86_64",
    })),
    systemImages: status.android.systemImages,
    deviceProfiles: [
      { id: "pixel_7", name: "Pixel 7" },
      { id: "pixel_8", name: "Pixel 8" },
    ],
    defaultDeviceProfile: "pixel_7",
  };
}

function createMobile(options: { devices: MobileDevice[]; status?: MobileSetupStatus }) {
  let devices = options.devices;
  let avdList = avdListFor(options.status ?? readyStatus());
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
    listAvds: vi.fn(async (): Promise<MobileAvdList> => avdList),
    createAvd: vi.fn(async (input: MobileAvdCreateInput): Promise<MobileAvdList> => {
      avdList = {
        ...avdList,
        avds: [...avdList.avds, { name: input.name, displayName: input.name.replaceAll("_", " ") }],
      };
      return avdList;
    }),
    deleteAvd: vi.fn(async (name: string): Promise<MobileAvdList> => {
      avdList = { ...avdList, avds: avdList.avds.filter((avd) => avd.name !== name) };
      return avdList;
    }),
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
    openUrl: vi.fn(async (_deviceId: string, _url: string): Promise<{ reversedPort?: number }> => ({})),
    logs: vi.fn(
      async (_deviceId: string, _query?: { appId?: string; lines?: number; filter?: string }): Promise<string[]> => [],
    ),
    launch: vi.fn(async (_deviceId: string, _appId: string, _options?: { stop?: boolean }) => undefined),
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
  vi.unstubAllGlobals();
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

async function render(bridge: ZliBridge, reveal?: MobileReveal, devServers?: readonly DevServerHint[]) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <RuntimeProvider bridge={bridge}>
        <MobilePane reveal={reveal} devServers={devServers} />
      </RuntimeProvider>,
    );
  });
  return container;
}

function nameField(container: HTMLElement): HTMLInputElement {
  const field = [...container.querySelectorAll<HTMLInputElement>(".mobile-avd-form input")][0];
  if (!field) throw new Error("No name field");
  return field;
}

function expoBanner(container: HTMLElement): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>(".banner")].find((banner) =>
    banner.textContent?.includes("Expo is running"),
  );
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

function menuLabels(): string[] {
  return [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent ?? "");
}

function menuItem(label: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent === label,
  );
  if (!found) throw new Error(`No menu item ${label}`);
  return found;
}

function pickerOptions(): string[] {
  return [...document.querySelectorAll('[role="option"]')].map(
    (option) => option.querySelector(".picker-option-label")?.textContent ?? "",
  );
}

function pickerOption(label: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (option) => option.querySelector(".picker-option-label")?.textContent === label,
  );
  if (!found) throw new Error(`No option ${label}`);
  return found;
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

  it("presses Power and Volume from the device buttons menu", async () => {
    const fake = createMobile({ devices: [emulator] });
    const container = await render(bridgeWith(fake.mobile));
    const more = button(container, "More device buttons");
    for (const [label, pressed] of [
      ["Power", "power"],
      ["Volume up", "volume_up"],
      ["Volume down", "volume_down"],
    ] as const) {
      await click(more);
      expect(menuLabels()).toEqual(["Power", "Volume up", "Volume down", "Copy screenshot"]);
      await click(menuItem(label));
      expect(fake.mobile.input).toHaveBeenLastCalledWith({
        deviceId: emulator.deviceId,
        type: "button",
        button: pressed,
      });
      expect(document.querySelector('[role="menu"]')).toBeNull();
    }
  });

  it("offers only Power on an iOS simulator, whose volume buttons idb cannot press", async () => {
    const simulator: MobileDevice = {
      deviceId: "ios:UDID-1",
      platform: "ios",
      kind: "simulator",
      name: "iPhone 16",
      state: "online",
      lease: null,
    };
    const fake = createMobile({ devices: [simulator] });
    const container = await render(bridgeWith(fake.mobile));
    await click(button(container, "More device buttons"));
    expect(menuLabels()).toEqual(["Power", "Copy screenshot"]);
  });

  it("rotates an iOS simulator on a Mac, and shows the Accessibility step when macOS refuses", async () => {
    const simulator: MobileDevice = {
      deviceId: "ios:UDID-1",
      platform: "ios",
      kind: "simulator",
      name: "iPhone 16",
      state: "online",
      lease: null,
    };
    const fake = createMobile({
      devices: [simulator],
      status: { ...readyStatus(), host: { os: "macos", arch: "arm64" } },
    });
    const container = await render(bridgeWith(fake.mobile));
    await click(button(container, "Rotate"));
    expect(fake.mobile.input).toHaveBeenLastCalledWith({ deviceId: simulator.deviceId, type: "rotate" });

    fake.mobile.input.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'zli:mobile:input': MobileDriverError: Allow ZLI in System Settings > Privacy & Security > Accessibility to rotate simulators.",
      ),
    );
    await click(button(container, "Rotate"));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Allow ZLI in System Settings > Privacy & Security > Accessibility to rotate simulators.",
    );
  });

  it("hides Rotate for a simulator when the host is not a Mac", async () => {
    const simulator: MobileDevice = {
      deviceId: "ios:UDID-1",
      platform: "ios",
      kind: "simulator",
      name: "iPhone 16",
      state: "online",
      lease: null,
    };
    const fake = createMobile({ devices: [simulator] });
    const container = await render(bridgeWith(fake.mobile));
    expect(() => button(container, "Rotate")).toThrow("No button Rotate");
    expect(() => button(container, "Home")).not.toThrow();
  });

  it("sends the person to Take over when they press Power while an agent holds the device", async () => {
    const held: MobileDevice = {
      ...emulator,
      lease: { ownerId: "s1", ownerLabel: "Codex", kind: "agent", acquiredAt: "2025-01-01T00:00:00.000Z" },
    };
    const fake = createMobile({ devices: [held] });
    const container = await render(bridgeWith(fake.mobile));
    await click(button(container, "More device buttons"));
    await click(menuItem("Power"));
    expect(fake.mobile.input).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button(container, "Take over"));
  });

  it("draws a phone frame around the screen and maps taps on the screen, not the frame", async () => {
    const fake = createMobile({ devices: [emulator] });
    const container = await render(bridgeWith(fake.mobile));
    await showStill(fake, emulator);
    const body = container.querySelector<HTMLElement>(".mobile-device");
    expect(body?.className).toBe("mobile-device is-framed is-phone is-portrait");
    expect(container.querySelector(".mobile-zoom")?.classList.contains("is-framed")).toBe(true);
    expect(body?.querySelector(".mobile-device-cutout.is-punch-hole")).not.toBeNull();
    expect(
      [...container.querySelectorAll(".mobile-device-key")].map((key) => [
        key.getAttribute("aria-label"),
        key.className,
      ]),
    ).toEqual([
      ["Power", "mobile-device-key is-right"],
      ["Volume up", "mobile-device-key is-right"],
      ["Volume down", "mobile-device-key is-right"],
    ]);
    // The body is larger than the screen and starts further up and left; taps must use the screen's own box.
    if (body)
      body.getBoundingClientRect = () =>
        ({ left: -12, top: -12, right: 282, bottom: 612, width: 294, height: 624 }) as DOMRect;
    const screen = sizedScreen(container);
    expect(body?.querySelector(".mobile-device-screen")?.contains(screen)).toBe(true);
    await act(async () => {
      pointer(screen, "pointerdown", 135, 300);
      pointer(screen, "pointerup", 135, 300);
    });
    expect(touches(fake)).toEqual(["down 540,1200", "up 540,1200"]);

    await act(async () => {
      fake.stream({ type: "still", deviceId: emulator.deviceId, data: pixel, width: 2400, height: 1080 });
    });
    expect(container.querySelector(".mobile-device")?.className).toBe("mobile-device is-framed is-phone is-landscape");
    expect([...container.querySelectorAll(".mobile-device-key")].map((key) => key.className)).toEqual([
      "mobile-device-key is-top",
      "mobile-device-key is-top",
      "mobile-device-key is-top",
    ]);
  });

  it("presses Power and Volume from the frame's side buttons, and sends the person to Take over while an agent holds it", async () => {
    const fake = createMobile({ devices: [emulator] });
    const container = await render(bridgeWith(fake.mobile));
    await showStill(fake, emulator);
    for (const [label, pressed] of [
      ["Power", "power"],
      ["Volume up", "volume_up"],
      ["Volume down", "volume_down"],
    ] as const) {
      const key = container.querySelector<HTMLButtonElement>(`.mobile-device-key[aria-label="${label}"]`);
      expect(key?.dataset.tooltip).toBe(label);
      if (key) await click(key);
      expect(fake.mobile.input).toHaveBeenLastCalledWith({
        deviceId: emulator.deviceId,
        type: "button",
        button: pressed,
      });
    }

    const held: MobileDevice = {
      ...emulator,
      lease: { ownerId: "s1", ownerLabel: "Codex", kind: "agent", acquiredAt: "2025-01-01T00:00:00.000Z" },
    };
    fake.mobile.input.mockClear();
    await act(async () => fake.publishDevices([held]));
    const power = container.querySelector<HTMLButtonElement>('.mobile-device-key[aria-label="Power"]');
    expect(power?.dataset.tooltip).toBe("Power. Take over first.");
    if (power) await click(power);
    expect(fake.mobile.input).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button(container, "Take over"));
  });

  it("draws an iPhone simulator with an island and Power only, since idb cannot press volume", async () => {
    const simulator: MobileDevice = {
      deviceId: "ios:UDID-1",
      platform: "ios",
      kind: "simulator",
      name: "iPhone 16",
      state: "online",
      lease: null,
    };
    const fake = createMobile({ devices: [simulator] });
    const container = await render(bridgeWith(fake.mobile));
    await act(async () => {
      fake.stream({ type: "still", deviceId: simulator.deviceId, data: pixel, width: 1179, height: 2556 });
    });
    expect(container.querySelector(".mobile-device-cutout.is-island")).not.toBeNull();
    expect(
      [...container.querySelectorAll("button.mobile-device-key")].map((key) => key.getAttribute("aria-label")),
    ).toEqual(["Power"]);
    const drawn = [...container.querySelectorAll("span.mobile-device-key")];
    expect(drawn.map((key) => [key.className, key.getAttribute("aria-hidden")])).toEqual([
      ["mobile-device-key is-left is-static", "true"],
      ["mobile-device-key is-left is-static", "true"],
    ]);
  });

  it("turns the device frame off from the menu, remembers it, and turns it back on", async () => {
    const fake = createMobile({ devices: [emulator] });
    const container = await render(bridgeWith(fake.mobile));
    await showStill(fake, emulator);
    await click(button(container, "More device buttons"));
    const toggle = document.querySelector<HTMLElement>('[role="menuitemcheckbox"]');
    expect(toggle?.textContent).toBe("Show device frame");
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    if (toggle) await click(toggle);
    expect(container.querySelector(".mobile-device.is-framed")).toBeNull();
    expect(container.querySelector(".mobile-device-key")).toBeNull();
    expect(container.querySelector("img.mobile-screen")).not.toBeNull();
    expect(window.localStorage.getItem("zli.mobile.skin.v1")).toBe("off");

    act(() => root?.unmount());
    document.body.replaceChildren();
    const again = await render(bridgeWith(fake.mobile));
    await showStill(fake, emulator);
    expect(again.querySelector(".mobile-device.is-framed")).toBeNull();
    await click(button(again, "More device buttons"));
    expect(document.querySelector('[role="menuitemcheckbox"]')?.getAttribute("aria-checked")).toBe("false");
    await click(document.querySelector<HTMLElement>('[role="menuitemcheckbox"]') as HTMLElement);
    expect(again.querySelector(".mobile-device.is-framed")).not.toBeNull();
    expect(window.localStorage.getItem("zli.mobile.skin.v1")).toBeNull();
  });

  it("offers Pop out only when the desktop app has pop-out windows", async () => {
    const fake = createMobile({ devices: [emulator] });
    const container = await render(bridgeWith(fake.mobile));
    expect(() => button(container, "Pop out")).toThrow("No button Pop out");
  });

  it("pops the device out, shows that it is in its own window instead of a second stream, and brings it back", async () => {
    const fake = createMobile({ devices: [emulator] });
    const popOutListeners = new Set<(popOuts: MobilePopOut[]) => void>();
    const publishPopOuts = (popOuts: MobilePopOut[]) => {
      for (const listener of popOutListeners) listener(popOuts);
    };
    const popOut = vi.fn(async (deviceId: string) => [{ deviceId, pinned: false }]);
    const closePopOut = vi.fn(async (_deviceId: string): Promise<MobilePopOut[]> => []);
    const mobile: MobileBridge = {
      ...fake.mobile,
      popOuts: async () => [],
      onPopOuts: (listener) => {
        popOutListeners.add(listener);
        return () => popOutListeners.delete(listener);
      },
      popOut,
      closePopOut,
    };
    const container = await render(bridgeWith(mobile));
    await showStill(fake, emulator);
    expect(fake.mobile.startStream).toHaveBeenCalledTimes(1);

    await click(button(container, "Pop out"));
    expect(popOut).toHaveBeenCalledWith(emulator.deviceId);
    expect(container.textContent).toContain("Pixel 8 is open in its own window.");
    expect(container.querySelector(".mobile-screen")).toBeNull();
    expect(fake.mobile.stopStream).toHaveBeenCalledWith(emulator.deviceId);
    expect(() => button(container, "More device buttons")).toThrow();

    await click(button(container, "Show the window"));
    expect(popOut).toHaveBeenCalledTimes(2);
    await click(button(container, "Bring it back"));
    expect(closePopOut).toHaveBeenCalledWith(emulator.deviceId);
    expect(container.textContent).not.toContain("is open in its own window");
    expect(fake.mobile.startStream).toHaveBeenCalledTimes(2);

    // A window closed from its own title bar gives the device back the same way.
    await act(async () => publishPopOuts([{ deviceId: emulator.deviceId, pinned: true }]));
    expect(container.textContent).toContain("Pixel 8 is open in its own window.");
    await act(async () => publishPopOuts([]));
    await showStill(fake, emulator);
    expect(container.querySelector("img.mobile-screen")).not.toBeNull();
  });

  it("disables Pop out until the device runs", async () => {
    const fake = createMobile({ devices: [{ ...emulator, state: "shutdown" }] });
    const popOut = vi.fn(async (deviceId: string) => [{ deviceId, pinned: false }]);
    const container = await render(bridgeWith({ ...fake.mobile, popOut }));
    expect(button(container, "Pop out").disabled).toBe(true);
    expect(button(container, "Pop out").getAttribute("data-tooltip")).toBe(
      "Pixel 8 needs to be running to open in its own window",
    );
  });

  it("opens a typed URL on the device and says when it forwarded a local port", async () => {
    vi.useFakeTimers();
    const fake = createMobile({ devices: [emulator] });
    fake.mobile.openUrl.mockResolvedValueOnce({ reversedPort: 3000 });
    const container = await render(bridgeWith(fake.mobile));
    await click(button(container, "Open URL"));
    const field = container.querySelector<HTMLInputElement>('input[aria-label="URL to open on Pixel 8"]');
    if (!field) throw new Error("No URL field");
    expect(document.activeElement).toBe(field);
    await act(async () => typeInto(field, "localhost:3000"));
    await click(button(container, "Open"));
    expect(fake.mobile.openUrl).toHaveBeenCalledWith(emulator.deviceId, "http://localhost:3000");
    expect(container.querySelector(".mobile-notice")?.textContent).toBe(
      "Opened http://localhost:3000. Forwarded localhost:3000 to the device.",
    );
    expect(container.querySelector('input[aria-label="URL to open on Pixel 8"]')).toBeNull();
    expect(document.activeElement).toBe(button(container, "Open URL"));
    await advance(3_000);
    expect(container.querySelector(".mobile-notice")?.textContent).toBe("");

    fake.mobile.openUrl.mockRejectedValueOnce(
      new Error("Error invoking remote method 'zli:mobile:open-url': Error: No app on the device opens that URL."),
    );
    await click(button(container, "Open URL"));
    await click(button(container, "Open"));
    expect(fake.mobile.openUrl).toHaveBeenLastCalledWith(emulator.deviceId, "http://localhost:3000");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("No app on the device opens that URL.");
  });

  it("sends the person to Take over when they open a URL while an agent holds the device", async () => {
    const held: MobileDevice = {
      ...emulator,
      lease: { ownerId: "s1", ownerLabel: "Codex", kind: "agent", acquiredAt: "2025-01-01T00:00:00.000Z" },
    };
    const fake = createMobile({ devices: [held] });
    const container = await render(bridgeWith(fake.mobile));
    await click(button(container, "Open URL"));
    const field = container.querySelector<HTMLInputElement>('input[aria-label="URL to open on Pixel 8"]');
    if (!field) throw new Error("No URL field");
    await act(async () => typeInto(field, "https://example.com"));
    await click(button(container, "Open"));
    expect(fake.mobile.openUrl).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button(container, "Take over"));
  });
  it("offers to open a detected Expo server on the running device, and stays dismissed for the session", async () => {
    const fake = createMobile({ devices: [emulator] });
    fake.mobile.openUrl.mockResolvedValueOnce({ reversedPort: 8081 });
    const servers = [
      { port: 5173, url: "http://localhost:5173/" },
      { port: 8081, url: "http://localhost:8081/" },
    ];
    let container = await render(bridgeWith(fake.mobile), undefined, servers);
    expect(fake.mobile.openUrl).not.toHaveBeenCalled();
    expect(expoBanner(container)?.getAttribute("role")).toBe("status");
    expect(expoBanner(container)?.querySelector(".banner-message")?.textContent).toBe(
      "Expo is running on localhost:8081.",
    );
    await click(button(container, "Open on Pixel 8"));
    expect(fake.mobile.openUrl).toHaveBeenCalledWith(emulator.deviceId, "exp://localhost:8081");
    expect(container.querySelector(".mobile-notice")?.textContent).toBe(
      "Opened exp://localhost:8081. Forwarded localhost:8081 to the device.",
    );

    await click(button(container, "Dismiss the Expo banner"));
    expect(expoBanner(container)).toBeUndefined();
    act(() => root?.unmount());
    container = await render(bridgeWith(fake.mobile), undefined, servers);
    expect(expoBanner(container)).toBeUndefined();
    act(() => root?.unmount());
    container = await render(bridgeWith(fake.mobile), undefined, [{ port: 19000, url: "http://localhost:19000/" }]);
    expect(expoBanner(container)?.textContent).toContain("Expo is running on localhost:19000.");
  });

  it("shows the Expo banner only for an Expo server and a running device", async () => {
    const fake = createMobile({ devices: [emulator] });
    let container = await render(bridgeWith(fake.mobile), undefined, [{ port: 5173, url: "http://localhost:5173/" }]);
    expect(expoBanner(container)).toBeUndefined();
    act(() => root?.unmount());
    container = await render(bridgeWith(fake.mobile), undefined, [
      { port: 4000, url: "http://localhost:4000/", name: "expo start" },
    ]);
    expect(expoBanner(container)?.textContent).toContain("localhost:4000");
    await act(async () => fake.publishDevices([{ ...emulator, state: "shutdown" }]));
    expect(expoBanner(container)).toBeUndefined();
    expect(fake.mobile.openUrl).not.toHaveBeenCalled();
  });

  it("sends the person to Take over when they open Expo while an agent holds the device", async () => {
    const held: MobileDevice = {
      ...emulator,
      lease: { ownerId: "s1", ownerLabel: "Codex", kind: "agent", acquiredAt: "2025-01-01T00:00:00.000Z" },
    };
    const fake = createMobile({ devices: [held] });
    const container = await render(bridgeWith(fake.mobile), undefined, [{ port: 8081, url: "http://localhost:8081/" }]);
    await click(button(container, "Open on Pixel 8"));
    expect(fake.mobile.openUrl).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button(container, "Take over"));
  });
  it("reads the device logs in the Logs drawer, filters them, copies them, and refreshes on a timer", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const fake = createMobile({ devices: [emulator] });
    fake.mobile.logs.mockResolvedValue(["I/App: started", "E/App: crashed"]);
    const container = await render(bridgeWith(fake.mobile));
    const toggle = button(container, "Logs");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(fake.mobile.logs).not.toHaveBeenCalled();

    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(fake.mobile.logs).toHaveBeenCalledWith(emulator.deviceId, { lines: 200 });
    expect(container.querySelector(".mobile-logs-list")?.textContent).toBe("I/App: started\nE/App: crashed");
    expect(window.sessionStorage.getItem("zli.mobile.logs.v1")).toBe("open");

    const field = (name: string) => {
      const found = container.querySelector<HTMLInputElement>(`.mobile-logs input[aria-label="${name}"]`);
      if (!found) throw new Error(`No field ${name}`);
      return found;
    };
    await act(async () => {
      typeInto(field("Only lines containing"), " crashed ");
      typeInto(field("Only this app"), "com.example.app");
      typeInto(field("Lines"), "50");
    });
    await click(button(container, "Refresh logs"));
    expect(fake.mobile.logs).toHaveBeenLastCalledWith(emulator.deviceId, {
      lines: 50,
      appId: "com.example.app",
      filter: "crashed",
    });

    await act(async () => typeInto(field("Only this app"), "com.example; reboot"));
    const calls = fake.mobile.logs.mock.calls.length;
    await click(button(container, "Refresh logs"));
    expect(fake.mobile.logs).toHaveBeenCalledTimes(calls);
    expect(container.querySelector('.mobile-logs [role="alert"]')?.textContent).toBe(
      "Use an app id like com.example.app.",
    );
    await act(async () => typeInto(field("Only this app"), ""));

    await click(button(container, "Copy all"));
    expect(writeText).toHaveBeenCalledWith("I/App: started\nE/App: crashed");
    expect(container.querySelector(".mobile-notice")?.textContent).toBe("Copied 2 log lines.");

    await act(async () => {
      container.querySelector<HTMLInputElement>(".mobile-logs-auto input")?.click();
    });
    const before = fake.mobile.logs.mock.calls.length;
    await advance(4_000);
    expect(fake.mobile.logs.mock.calls.length).toBe(before + 2);

    await click(toggle);
    expect(container.querySelector(".mobile-logs-panel")).toBeNull();
    await advance(4_000);
    expect(fake.mobile.logs.mock.calls.length).toBe(before + 2);
    expect(window.sessionStorage.getItem("zli.mobile.logs.v1")).toBe("closed");
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("keeps the Logs drawer open for the session and waits for Take over while an agent holds the device", async () => {
    window.sessionStorage.setItem("zli.mobile.logs.v1", "open");
    const held: MobileDevice = {
      ...emulator,
      lease: { ownerId: "s1", ownerLabel: "Codex", kind: "agent", acquiredAt: "2025-01-01T00:00:00.000Z" },
    };
    const fake = createMobile({ devices: [held] });
    const container = await render(bridgeWith(fake.mobile));
    expect(button(container, "Logs").getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".mobile-logs")?.textContent).toContain("Take over to read this device's logs.");
    expect(fake.mobile.logs).not.toHaveBeenCalled();
    await click(button(container, "Refresh logs"));
    expect(fake.mobile.logs).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button(container, "Take over"));
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

  it("keeps Cancel busy until the shutdown finishes, even after the stopped boot returns", async () => {
    const off: MobileDevice = { ...emulator, state: "shutdown", serial: undefined };
    const fake = createMobile({ devices: [off] });
    let failBoot: ((cause: Error) => void) | undefined;
    fake.mobile.boot.mockImplementation(
      () =>
        new Promise<MobileDevice>((_resolve, reject) => {
          failBoot = reject;
        }),
    );
    let finishShutdown: (() => void) | undefined;
    fake.mobile.shutdown.mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          failBoot?.(new Error("Booting Pixel 8 was cancelled."));
          finishShutdown = () => resolve(undefined);
        }),
    );
    const container = await render(bridgeWith(fake.mobile));
    await click(button(container, "Boot"));
    await act(async () => {
      fake.publishDevices([{ ...off, state: "booting" }]);
    });
    await click(button(container, "Cancel"));
    expect(button(container, "Cancel").getAttribute("aria-busy")).toBe("true");
    await act(async () => finishShutdown?.());
    expect(button(container, "Cancel").getAttribute("aria-busy")).toBeNull();
  });

  it("switches a device to 100%, remembers it, and maps taps through the scrolled stage", async () => {
    const fake = createMobile({ devices: [emulator] });
    const container = await render(bridgeWith(fake.mobile));
    await showStill(fake, emulator);
    expect(container.querySelector(".mobile-stage")?.classList.contains("is-actual")).toBe(false);
    expect(button(container, "Fit").getAttribute("aria-pressed")).toBe("true");

    await click(button(container, "100%, device pixels"));
    expect(container.querySelector(".mobile-stage")?.classList.contains("is-actual")).toBe(true);
    expect(JSON.parse(window.localStorage.getItem("zli.mobile.zoom.v1") ?? "{}")).toEqual({
      [emulator.deviceId]: "actual",
    });
    const screen = container.querySelector<HTMLImageElement>("img.mobile-screen");
    if (!screen) throw new Error("No screen");
    // In the frame the body takes the device pixels plus its bezel, and the screen fills its opening.
    const body = container.querySelector<HTMLElement>(".mobile-device.is-framed");
    expect([body?.style.width, body?.style.height]).toEqual(["1170px", "2490px"]);
    expect(screen.style.width).toBe("");
    // Scrolled 100 pixels right and 400 down, the screen's box starts above and left of the stage.
    screen.getBoundingClientRect = () =>
      ({ left: -100, top: -400, right: 980, bottom: 2000, width: 1080, height: 2400 }) as DOMRect;
    await act(async () => {
      pointer(screen, "pointerdown", 440, 800);
      pointer(screen, "pointerup", 440, 800);
    });
    expect(touches(fake)).toEqual(["down 540,1200", "up 540,1200"]);

    await click(button(container, "More device buttons"));
    await click(document.querySelector<HTMLElement>('[role="menuitemcheckbox"]') as HTMLElement);
    expect(container.querySelector<HTMLImageElement>("img.mobile-screen")?.style.width).toBe("1080px");

    act(() => root?.unmount());
    document.body.replaceChildren();
    const again = await render(bridgeWith(createMobile({ devices: [emulator] }).mobile));
    expect(again.querySelector(".mobile-stage")?.classList.contains("is-actual")).toBe(true);
    await click(button(again, "Fit"));
    expect(again.querySelector(".mobile-stage")?.classList.contains("is-actual")).toBe(false);
    expect(window.localStorage.getItem("zli.mobile.zoom.v1")).toBe("{}");
  });

  it("names the saved screenshot in a short confirmation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 25, 14, 22, 33));
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const fake = createMobile({ devices: [emulator] });
    const container = await render(bridgeWith(fake.mobile));
    await click(button(container, "Save a screenshot"));
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".mobile-notice")?.textContent).toBe("Saved Pixel-8-20261025-142233.png");
    await advance(3_000);
    expect(container.querySelector(".mobile-notice")?.textContent).toBe("");
    clicked.mockRestore();
  });

  it("copies the screenshot to the clipboard as a PNG, and says when the clipboard refuses", async () => {
    class FakeClipboardItem {
      constructor(readonly items: Record<string, Promise<Blob>>) {}
    }
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);
    const write = vi.fn(async (_items: FakeClipboardItem[]) => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write } });
    const fake = createMobile({ devices: [emulator] });
    const container = await render(bridgeWith(fake.mobile));

    await click(button(container, "More device buttons"));
    expect(menuLabels()).toEqual(["Power", "Volume up", "Volume down", "Copy screenshot"]);
    await click(menuItem("Copy screenshot"));
    expect(fake.mobile.screenshot).toHaveBeenCalledWith(emulator.deviceId);
    const image = await write.mock.calls[0]?.[0][0]?.items["image/png"];
    expect(image?.type).toBe("image/png");
    expect(image?.size).toBeGreaterThan(0);
    expect(container.querySelector(".mobile-notice")?.textContent).toBe("Copied the screenshot.");

    write.mockRejectedValueOnce(new DOMException("Write permission denied.", "NotAllowedError"));
    await click(button(container, "More device buttons"));
    await click(menuItem("Copy screenshot"));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "ZLI could not put the image on the clipboard. Save the screenshot instead.",
    );

    vi.unstubAllGlobals();
    await click(button(container, "More device buttons"));
    await click(menuItem("Copy screenshot"));
    expect(write).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "ZLI could not put the image on the clipboard. Save the screenshot instead.",
    );
    Reflect.deleteProperty(navigator, "clipboard");
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
    expect(chip?.textContent).toBe("Screenshots");
    expect(chip?.getAttribute("title")).toBe("About 1 per second. scrcpy could not start.");
  });

  it("shows the device picker with one device, and with none, so the toolbar keeps its shape", async () => {
    const fake = createMobile({ devices: [emulator] });
    const container = await render(bridgeWith(fake.mobile));
    const picker = button(container, "Device: Pixel 8");
    expect(picker.getAttribute("aria-disabled")).toBeNull();
    await click(picker);
    expect(pickerOptions()).toEqual(["Pixel 8", "New virtual device"]);

    act(() => root?.unmount());
    document.body.replaceChildren();
    const empty = createMobile({ devices: [] });
    const emptyContainer = await render(bridgeWith(empty.mobile));
    const disabled = button(emptyContainer, "Device: No devices");
    expect(disabled.getAttribute("aria-disabled")).toBe("true");
    await click(disabled);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it("groups the picker into emulators, phones, and simulators, and opens Setup for a new virtual device", async () => {
    const phone: MobileDevice = {
      deviceId: "android:R5CT",
      platform: "android",
      kind: "physical",
      name: "Galaxy S23",
      state: "unauthorized",
      lease: null,
    };
    const simulator: MobileDevice = {
      deviceId: "ios:UDID-1",
      platform: "ios",
      kind: "simulator",
      name: "iPhone 16",
      state: "shutdown",
      osVersion: "18.2",
      lease: null,
    };
    const fake = createMobile({ devices: [simulator, phone, emulator] });
    const container = await render(bridgeWith(fake.mobile));
    await click(button(container, "Device: Pixel 8"));
    const groups = [...document.querySelectorAll('[role="listbox"] > [role="group"]')].map((group) => {
      const labelId = group.getAttribute("aria-labelledby");
      return {
        label: labelId ? document.getElementById(labelId)?.textContent : undefined,
        options: [...group.querySelectorAll('[role="option"]')].map((option) => option.textContent),
      };
    });
    expect(groups).toEqual([
      { label: "Emulators", options: ["Pixel 8Android 15, running"] },
      { label: "Phones", options: ["Galaxy S23Android, waiting for approval"] },
      { label: "Simulators", options: ["iPhone 16iOS 18.2, off"] },
      { label: undefined, options: ["New virtual device"] },
    ]);

    await click(pickerOption("New virtual device"));
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(button(container, "Setup").getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).toContain("Ready, with the virtual device Pixel_8.");
    expect(container.querySelector(".mobile-toolbar")).toBeNull();
    expect(document.activeElement).toBe(nameField(container));

    await click(button(container, "Setup"));
    await click(button(container, "Setup"));
    expect(container.textContent).toContain("Virtual devices");
    expect(document.activeElement).not.toBe(nameField(container));
  });

  it("lists virtual devices with Boot and Delete, and deletes one only after a confirm step", async () => {
    const off: MobileDevice = { ...emulator, deviceId: "android-avd:Pixel_9", name: "Pixel 9", state: "shutdown" };
    const status = readyStatus();
    status.android.avds = ["Pixel_8", "Pixel_9"];
    const fake = createMobile({ devices: [emulator, off], status });
    const container = await render(bridgeWith(fake.mobile));
    await click(button(container, "Setup"));
    const rows = [...container.querySelectorAll(".mobile-avd")].map((row) => row.textContent);
    expect(rows).toEqual([
      "Pixel 8API 35, Google APIs, x86_64, RunningDelete",
      "Pixel 9API 35, Google APIs, x86_64, OffBootDelete",
    ]);
    expect(button(container, "Delete Pixel 8").disabled).toBe(true);
    expect(button(container, "Delete Pixel 8").dataset.tooltip).toBe("Shut it down before deleting it");

    await click(button(container, "Delete Pixel 9"));
    expect(fake.mobile.deleteAvd).not.toHaveBeenCalled();
    expect(container.querySelector('fieldset[aria-label="Delete Pixel 9?"]')?.textContent).toContain(
      "Delete it and its data?",
    );
    await click(button(container, "Keep it"));
    expect(container.querySelector('[aria-label="Delete Pixel 9?"]')).toBeNull();

    fake.mobile.devices.mockClear();
    fake.mobile.status.mockClear();
    await click(button(container, "Delete Pixel 9"));
    await click(button(container, "Delete Pixel 9 for good"));
    expect(fake.mobile.deleteAvd).toHaveBeenCalledWith("Pixel_9");
    expect([...container.querySelectorAll(".mobile-avd-name")].map((name) => name.textContent)).toEqual(["Pixel 8"]);
    expect(container.textContent).toContain("Deleted Pixel 9.");
    expect(fake.mobile.devices).toHaveBeenCalled();
    expect(fake.mobile.status).toHaveBeenCalled();
  });

  it("creates a virtual device from an installed image and a device profile", async () => {
    const fake = createMobile({ devices: [emulator] });
    const container = await render(bridgeWith(fake.mobile));
    await click(button(container, "Setup"));
    expect(nameField(container).value).toBe("Pixel_7_API_35");
    expect(container.textContent).toContain("Only system images already on this computer are listed.");
    await click(button(container, "Device profile: Pixel 7"));
    await click(pickerOption("Pixel 8"));
    expect(nameField(container).value).toBe("Pixel_8_API_35");

    await act(async () => typeInto(nameField(container), "Pixel 9"));
    expect(container.textContent).toContain("Use letters, digits, and _ . - only, starting with a letter or digit.");
    expect(button(container, "Create").disabled).toBe(true);
    await act(async () => typeInto(nameField(container), "pixel_8"));
    expect(container.textContent).toContain("A virtual device with this name already exists.");

    await act(async () => typeInto(nameField(container), "Pixel_9"));
    await click(button(container, "Create"));
    expect(fake.mobile.createAvd).toHaveBeenCalledWith({
      name: "Pixel_9",
      systemImage: "system-images;android-35;google_apis;x86_64",
      device: "pixel_8",
    });
    expect(container.textContent).toContain("Created Pixel_9. Boot it from the list.");
    expect([...container.querySelectorAll(".mobile-avd-name")].map((name) => name.textContent)).toEqual([
      "Pixel 8",
      "Pixel 9",
    ]);
    expect(nameField(container).value).toBe("Pixel_8_API_35");

    fake.mobile.createAvd.mockRejectedValueOnce(
      new Error("Error invoking remote method 'zli:mobile:avd-create': Error: avdmanager create failed: no space"),
    );
    await click(button(container, "Create"));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("avdmanager create failed: no space");
  });

  it("boots a virtual device from the list and goes back to the device view", async () => {
    const off: MobileDevice = { ...emulator, deviceId: "android-avd:Pixel_9", name: "Pixel 9", state: "shutdown" };
    const status = readyStatus();
    status.android.avds = ["Pixel_8", "Pixel_9"];
    const fake = createMobile({ devices: [emulator, off], status });
    const container = await render(bridgeWith(fake.mobile));
    await click(button(container, "Setup"));
    await click(button(container, "Boot Pixel 9"));
    expect(fake.mobile.boot).toHaveBeenCalledWith("android-avd:Pixel_9");
    expect(button(container, "Setup").getAttribute("aria-pressed")).toBe("false");
    expect(button(container, "Device: Pixel 9")).toBeDefined();
  });

  it("lists virtual devices without avdmanager but explains why it cannot create or delete them", async () => {
    const status = readyStatus();
    status.android.avdmanager = { found: false };
    const fake = createMobile({ devices: [emulator], status });
    const container = await render(bridgeWith(fake.mobile));
    await click(button(container, "Setup"));
    expect(container.textContent).toContain("Creating and deleting virtual devices needs avdmanager");
    expect(container.querySelector(".mobile-avd-form")).toBeNull();
    expect(button(container, "Delete Pixel 8").disabled).toBe(true);
    expect(button(container, "Delete Pixel 8").dataset.tooltip).toBe("Needs avdmanager");
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
