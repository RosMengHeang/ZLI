// @vitest-environment jsdom

import type {
  MobileAvdList,
  MobileDevice,
  MobileSimulatorCatalog,
  MobileSimulatorCreateInput,
} from "@zli-v2/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type CreatedDevice, NewDeviceDialog, type NewDevicePlatform } from "./NewDeviceDialog.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const TYPE = "com.apple.CoreSimulator.SimDeviceType.";
const RUNTIME = "com.apple.CoreSimulator.SimRuntime.";

const catalog: MobileSimulatorCatalog = {
  simctl: true,
  deviceTypes: [
    { id: `${TYPE}iPhone-15`, name: "iPhone 15", family: "iPhone" },
    { id: `${TYPE}iPhone-16-Pro`, name: "iPhone 16 Pro", family: "iPhone" },
    { id: `${TYPE}iPad-Air-M2`, name: "iPad Air (M2)", family: "iPad" },
  ],
  runtimes: [
    {
      id: `${RUNTIME}iOS-17-5`,
      name: "iOS 17.5",
      version: "17.5",
      deviceTypeIds: [`${TYPE}iPhone-15`, `${TYPE}iPad-Air-M2`],
    },
    {
      id: `${RUNTIME}iOS-18-2`,
      name: "iOS 18.2",
      version: "18.2",
      deviceTypeIds: [`${TYPE}iPhone-15`, `${TYPE}iPhone-16-Pro`, `${TYPE}iPad-Air-M2`],
    },
  ],
};

const avds: MobileAvdList = {
  avdmanager: true,
  avds: [],
  systemImages: ["system-images;android-35;google_apis;x86_64"],
  deviceProfiles: [{ id: "pixel_7", name: "Pixel 7" }],
  defaultDeviceProfile: "pixel_7",
};

const existing: MobileDevice = {
  deviceId: "ios:AAAA",
  platform: "ios",
  kind: "simulator",
  name: "iPhone 16 Pro",
  state: "shutdown",
  lease: null,
};

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

function createMobile(options: { catalog?: Promise<MobileSimulatorCatalog> } = {}) {
  return {
    listAvds: vi.fn(async () => avds),
    createAvd: vi.fn(async () => avds),
    listSimulators: vi.fn(() => options.catalog ?? Promise.resolve(catalog)),
    createSimulator: vi.fn(async (input: MobileSimulatorCreateInput) => ({ deviceId: "ios:NEW", name: input.name })),
  };
}

async function render(
  mobile: ReturnType<typeof createMobile>,
  platforms: NewDevicePlatform[],
  handlers: { onCreated?: (created: CreatedDevice) => void; onClose?: () => void } = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <NewDeviceDialog
        mobile={mobile}
        platforms={platforms}
        devices={[existing]}
        onCreated={handlers.onCreated ?? (() => undefined)}
        onClose={handlers.onClose ?? (() => undefined)}
      />,
    );
  });
}

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
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

function nameField(): HTMLInputElement {
  const field = document.querySelector<HTMLInputElement>(".new-device-form .field input");
  if (!field) throw new Error("No name field");
  return field;
}

function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function options(): Array<{ label: string | undefined; options: string[] }> {
  return [...document.querySelectorAll('[role="listbox"] > [role="group"]')].map((group) => {
    const labelId = group.getAttribute("aria-labelledby");
    return {
      label: labelId ? (document.getElementById(labelId)?.textContent ?? undefined) : undefined,
      options: [...group.querySelectorAll(".picker-option-label")].map((option) => option.textContent ?? ""),
    };
  });
}

function option(label: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (candidate) => candidate.querySelector(".picker-option-label")?.textContent === label,
  );
  if (!found) throw new Error(`No option ${label}`);
  return found;
}

describe("NewDeviceDialog", () => {
  it("creates an iPhone simulator from a model and an iOS version that runs it", async () => {
    const mobile = createMobile();
    const onCreated = vi.fn();
    await render(mobile, ["ios"], { onCreated });
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("New device");
    expect(document.querySelector('[role="radiogroup"]')).toBeNull();
    // iPhone 16 Pro is taken, so the suggestion is numbered.
    expect(nameField().value).toBe("iPhone 16 Pro (2)");
    expect(document.activeElement).toBe(nameField());
    expect(button("iOS version: iOS 18.2")).toBeDefined();

    await click(button("Model: iPhone 16 Pro"));
    expect(options()).toEqual([
      { label: "iPhone", options: ["iPhone 15", "iPhone 16 Pro"] },
      { label: "iPad", options: ["iPad Air (M2)"] },
    ]);
    await click(option("iPhone 15"));
    expect(nameField().value).toBe("iPhone 15");
    await click(button("iOS version: iOS 18.2"));
    expect(options()).toEqual([]);
    expect([...document.querySelectorAll(".picker-option-label")].map((entry) => entry.textContent)).toEqual([
      "iOS 18.2",
      "iOS 17.5",
    ]);
    await click(option("iOS 17.5"));

    await act(async () => typeInto(nameField(), "Checkout phone "));
    expect(document.body.textContent).toContain("do not end with a space");
    expect(button("Create").disabled).toBe(true);
    await act(async () => typeInto(nameField(), "iphone 16 pro"));
    expect(document.body.textContent).toContain("A simulator with this name already exists.");
    await act(async () => typeInto(nameField(), "Checkout phone"));
    await click(button("Create"));
    expect(mobile.createSimulator).toHaveBeenCalledWith({
      name: "Checkout phone",
      deviceTypeId: `${TYPE}iPhone-15`,
      runtimeId: `${RUNTIME}iOS-17-5`,
    });
    expect(onCreated).toHaveBeenCalledWith({ platform: "ios", name: "Checkout phone", deviceId: "ios:NEW" });
  });

  it("names what it is loading, then shows simctl's error next to the form", async () => {
    let finish: (value: MobileSimulatorCatalog) => void = () => undefined;
    const mobile = createMobile({ catalog: new Promise((resolve) => (finish = resolve)) });
    await render(mobile, ["ios"]);
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "Reading iPhone models and iOS versions from Xcode",
    );
    await act(async () => finish(catalog));
    mobile.createSimulator.mockRejectedValueOnce(
      new Error("Error invoking remote method 'zli:mobile:sim-create': Error: xcrun simctl failed: disk full"),
    );
    await click(button("Create"));
    expect(document.querySelector('.new-device-form [role="alert"]')?.textContent).toBe(
      "xcrun simctl failed: disk full",
    );
    expect(button("Create").disabled).toBe(false);
  });

  it("says what is missing when Xcode has no simulator runtime", async () => {
    const mobile = createMobile({ catalog: Promise.resolve({ ...catalog, runtimes: [] }) });
    await render(mobile, ["ios"]);
    expect(document.body.textContent).toContain("Xcode has no iOS version installed for simulators.");
    expect(button("Create").disabled).toBe(true);
  });

  it("switches between the Android emulator and iPhone simulator forms", async () => {
    const mobile = createMobile();
    await render(mobile, ["android", "ios"]);
    const radios = [...document.querySelectorAll<HTMLInputElement>('[role="radiogroup"] input')];
    expect(radios.map((radio) => radio.parentElement?.textContent)).toEqual(["Android emulator", "iPhone simulator"]);
    expect(nameField().value).toBe("Pixel_7_API_35");
    expect(document.querySelector('form[aria-label="New Android emulator"]')).not.toBeNull();
    (radios[1] as HTMLInputElement).focus();
    await click(radios[1] as HTMLInputElement);
    expect(document.querySelector('form[aria-label="New iPhone simulator"]')).not.toBeNull();
    expect(nameField().value).toBe("iPhone 16 Pro (2)");
    expect(document.activeElement).toBe(radios[1]);
  });

  it("closes on Escape and Cancel", async () => {
    const mobile = createMobile();
    const onClose = vi.fn();
    const outside = vi.fn();
    window.addEventListener("keydown", outside);
    await render(mobile, ["ios"], { onClose });
    await act(async () => {
      nameField().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    // The shell's Escape would close whatever the dialog opened from too.
    expect(outside).not.toHaveBeenCalled();
    await click(button("Cancel"));
    expect(onClose).toHaveBeenCalledTimes(2);
    window.removeEventListener("keydown", outside);
  });
});
