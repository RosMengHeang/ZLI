// @vitest-environment jsdom

import type { MobileDevice, MobilePopOut, MobileStreamEvent } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { rootView } from "../rootView.js";
import type { MobileBridge, ZliBridge } from "../runtime/bridge.js";
import { AppShell } from "../shell/AppShell.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const emulator: MobileDevice = {
  deviceId: "android-avd:Pixel_8",
  platform: "android",
  kind: "emulator",
  name: "Pixel_8",
  state: "online",
  osVersion: "15",
  serial: "emulator-5554",
  lease: null,
};

const search = `?view=mobile-device&deviceId=${encodeURIComponent(emulator.deviceId)}`;

function createMobile(devices: MobileDevice[]) {
  const streamListeners = new Set<(event: MobileStreamEvent) => void>();
  const popOutListeners = new Set<(popOuts: MobilePopOut[]) => void>();
  const mobile = {
    status: vi.fn(async () => ({ host: { os: "linux", arch: "x64" } })),
    devices: vi.fn(async () => devices),
    onDevices: () => () => undefined,
    startStream: vi.fn(async (deviceId: string) => ({ deviceId, mode: "stills" as const, width: 0, height: 0 })),
    stopStream: vi.fn(async () => undefined),
    onStream: (listener: (event: MobileStreamEvent) => void) => {
      streamListeners.add(listener);
      return () => streamListeners.delete(listener);
    },
    input: vi.fn(async () => undefined),
    takeOver: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    popOuts: vi.fn(async (): Promise<MobilePopOut[]> => [{ deviceId: emulator.deviceId, pinned: false }]),
    onPopOuts: (listener: (popOuts: MobilePopOut[]) => void) => {
      popOutListeners.add(listener);
      return () => popOutListeners.delete(listener);
    },
    pinPopOut: vi.fn(async (deviceId: string, pinned: boolean) => [{ deviceId, pinned }]),
    closePopOut: vi.fn(async (): Promise<MobilePopOut[]> => []),
    setPopOutAspect: vi.fn(async () => undefined),
  };
  return {
    mobile,
    bridge: { mobile: mobile as unknown as MobileBridge } as unknown as ZliBridge,
    still: async () =>
      act(async () => {
        for (const listener of streamListeners)
          listener({ type: "still", deviceId: emulator.deviceId, data: pixel, width: 1080, height: 2400 });
      }),
    popOutsChanged: async (popOuts: MobilePopOut[]) =>
      act(async () => {
        for (const listener of popOutListeners) listener(popOuts);
      }),
  };
}

let root: Root | undefined;

beforeAll(() => {
  HTMLElement.prototype.setPointerCapture ??= () => undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  window.localStorage.clear();
});

async function render(bridge: ZliBridge, query = search) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(rootView(query, bridge));
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

describe("MobileDeviceWindow", () => {
  it("renders the standalone device view for the pop-out route, and the app otherwise", async () => {
    expect(rootView("", undefined).type).toBe(AppShell);
    expect(rootView("?view=mobile-device", undefined).type).toBe(AppShell);
    const fake = createMobile([emulator]);
    const container = await render(fake.bridge);
    expect(container.querySelector(".mobile-window-bar")?.textContent).toContain("Pixel_8");
    expect(document.title).toBe("Pixel_8");
    expect(fake.mobile.startStream).toHaveBeenCalledWith(emulator.deviceId);
    await fake.still();
    expect(container.querySelector(".mobile-device.is-framed img.mobile-screen")).not.toBeNull();
    expect(button(container, "Back").querySelector(".mobile-controls-label")?.textContent).toBe("Back");
    expect(container.querySelector(".mobile-window-detail")?.textContent).toBe("Android Emulator");
    expect(container.querySelector(".app-shell")).toBeNull();
  });

  it("keeps the window on top from the pin, and follows the pin when it changes elsewhere", async () => {
    const fake = createMobile([emulator]);
    const container = await render(fake.bridge);
    const pin = button(container, "Keep on top");
    expect(pin.getAttribute("aria-pressed")).toBe("false");
    await act(async () => pin.click());
    expect(fake.mobile.pinPopOut).toHaveBeenCalledWith(emulator.deviceId, true);
    expect(pin.getAttribute("aria-pressed")).toBe("true");
    expect(pin.getAttribute("data-tooltip")).toBe("Stop keeping this window on top");
    await fake.popOutsChanged([{ deviceId: emulator.deviceId, pinned: false }]);
    expect(pin.getAttribute("aria-pressed")).toBe("false");
  });

  it("tells the window the framed device's shape and the room its bars take", async () => {
    const fake = createMobile([emulator]);
    const container = await render(fake.bridge);
    const measure = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("mobile-zoom")
        ? ({ left: 12, top: 48, width: 376, height: 700 } as DOMRect)
        : measure.call(this);
    });
    await fake.still();
    expect(container.querySelector(".mobile-zoom")).not.toBeNull();
    // A Pixel body is 1170 x 2490 around its 1080 x 2400 screen.
    expect(fake.mobile.setPopOutAspect).toHaveBeenLastCalledWith({
      deviceId: emulator.deviceId,
      aspect: 1170 / 2490,
      extraWidth: window.innerWidth - 376,
      extraHeight: window.innerHeight - 700,
    });
  });

  it("shows the lease banner and sends the person to Take over while an agent holds the device", async () => {
    const held: MobileDevice = {
      ...emulator,
      lease: { ownerId: "agent:1", ownerLabel: "Claude", kind: "agent", acquiredAt: new Date().toISOString() },
    };
    const fake = createMobile([held]);
    const container = await render(fake.bridge);
    await fake.still();
    expect(container.querySelector('[role="status"].banner')?.textContent).toContain("Claude");
    await act(async () => button(container, "Back").click());
    expect(fake.mobile.input).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button(container, "Take over"));
    await act(async () => button(container, "Take over").click());
    expect(fake.mobile.takeOver).toHaveBeenCalledWith(emulator.deviceId);
  });

  it("says when the device stops running or is gone, and closes the window on request", async () => {
    const off = createMobile([{ ...emulator, state: "shutdown" }]);
    const offContainer = await render(off.bridge);
    expect(offContainer.textContent).toContain("Pixel_8 is not running");
    expect(off.mobile.startStream).not.toHaveBeenCalled();
    act(() => root?.unmount());
    document.body.replaceChildren();

    const gone = createMobile([]);
    const container = await render(gone.bridge);
    expect(container.textContent).toContain("This device is gone");
    await act(async () => button(container, "Close window").click());
    expect(gone.mobile.closePopOut).toHaveBeenCalledWith(emulator.deviceId);
  });
});
