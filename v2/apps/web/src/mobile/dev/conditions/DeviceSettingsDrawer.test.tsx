// @vitest-environment jsdom

import type { MobileDevice } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConditionsApi } from "./bridge.js";
import { DeviceSettingsDrawer, parseLocation } from "./DeviceSettingsDrawer.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const pixel = {
  deviceId: "android-avd:Pixel_7",
  platform: "android",
  kind: "emulator",
  name: "Pixel 7",
} as MobileDevice;
const galaxy = { deviceId: "android:R58M", platform: "android", kind: "physical", name: "Galaxy" } as MobileDevice;
const iphone = { deviceId: "ios:UDID-1", platform: "ios", kind: "simulator", name: "iPhone 16" } as MobileDevice;

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

function api(overrides: Partial<ConditionsApi> = {}): ConditionsApi {
  const done = async () => ({ message: "Done." });
  return {
    get: vi.fn(async () => ({ appearance: "light", textSize: "default" }) as const),
    setAppearance: vi.fn(async () => ({ message: "Switched Pixel 7 to dark appearance." })),
    setTextSize: vi.fn(done),
    setLocation: vi.fn(done),
    clearLocation: vi.fn(done),
    setPermission: vi.fn(done),
    sendNotification: vi.fn(done),
    ...overrides,
  };
}

async function render(props: Partial<Parameters<typeof DeviceSettingsDrawer>[0]> & { conditions: ConditionsApi }) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <DeviceSettingsDrawer
        device={pixel}
        inputBlocked={false}
        onBlockedInput={() => undefined}
        onClose={() => undefined}
        {...props}
      />,
    ),
  );
  return container;
}

const button = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === name) as HTMLButtonElement;

const field = (container: HTMLElement, label: string) =>
  container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("device settings drawer", () => {
  it("presses what the device reports and says what a change did", async () => {
    const conditions = api();
    const container = await render({ conditions });
    expect(conditions.get).toHaveBeenCalledWith(pixel.deviceId);
    expect(button(container, "Light").getAttribute("aria-pressed")).toBe("true");

    await act(async () => button(container, "Dark").click());
    expect(conditions.setAppearance).toHaveBeenCalledWith(pixel.deviceId, "dark");
    expect(button(container, "Dark").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Switched Pixel 7 to dark appearance.");
  });

  it("shows why a device cannot take a setting instead of its controls", async () => {
    const container = await render({ conditions: api(), device: galaxy });
    expect(field(container, "Latitude")).toBeNull();
    expect(container.textContent).toContain("ZLI can set the location only on an emulator.");
    expect(container.textContent).toContain("Android has no command that posts a notification as your app.");
  });

  it("asks for an app id before changing a permission, and shows a failure under the control", async () => {
    const conditions = api({ setPermission: vi.fn(async () => Promise.reject(new Error("adb is not running."))) });
    const container = await render({ conditions });
    await act(async () => button(container, "Grant").click());
    expect(conditions.setPermission).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Type the app id first, such as com.example.app.",
    );

    await act(async () => type(field(container, "App id"), "com.example.app"));
    await act(async () => button(container, "Revoke").click());
    expect(conditions.setPermission).toHaveBeenCalledWith(pixel.deviceId, {
      appId: "com.example.app",
      permission: "camera",
      grant: false,
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("adb is not running.");
  });

  it("disables a permission the device cannot set and says why", async () => {
    const container = await render({ conditions: api(), device: iphone });
    expect(button(container, "Grant").disabled).toBe(true);
    expect(container.textContent).toContain("The iOS Simulator has no camera");
  });

  it("checks the location before sending it", async () => {
    const conditions = api();
    const container = await render({ conditions });
    await act(async () => type(field(container, "Latitude"), "37.7749, -122.4194"));
    await act(async () => button(container, "Set").click());
    expect(conditions.setLocation).toHaveBeenCalledWith(pixel.deviceId, { latitude: 37.7749, longitude: -122.4194 });
    expect(field(container, "Longitude").value).toBe("-122.4194");

    await act(async () => type(field(container, "Latitude"), "120"));
    await act(async () => button(container, "Set").click());
    expect(conditions.setLocation).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Latitude is a number from -90 to 90, such as 37.7749.",
    );
  });

  it("fills the app id from the project check", async () => {
    const doctor = { check: vi.fn(async () => ({ appIds: { android: "com.example.app" } }) as never) };
    const container = await render({ conditions: api(), doctor, worktreeId: "wt-1" });
    expect(doctor.check).toHaveBeenCalledWith("wt-1");
    expect(field(container, "App id").value).toBe("com.example.app");
  });

  it("waits for Take over while an agent holds the device", async () => {
    const conditions = api();
    const container = await render({ conditions, inputBlocked: true });
    expect(conditions.get).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Take over to change this device's settings.");
    expect(button(container, "Dark")).toBeUndefined();
  });
});

describe("parseLocation", () => {
  it("reads two fields or a pasted pair and refuses what is not a coordinate", () => {
    expect(parseLocation("51.5", "-0.12")).toEqual({ latitude: 51.5, longitude: -0.12 });
    expect(parseLocation("51.5, -0.12", "")).toEqual({ latitude: 51.5, longitude: -0.12 });
    expect(parseLocation("", "")).toHaveProperty("error");
    expect(parseLocation("1e2", "0")).toHaveProperty("error");
    expect(parseLocation("10", "181")).toEqual({ error: "Longitude is a number from -180 to 180, such as -122.4194." });
  });
});
