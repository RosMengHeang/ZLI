// @vitest-environment jsdom

import type { MobileDevice, MobileWifiResult } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { PhoneConnections } from "./PhoneConnections.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const wifiPhone: MobileDevice = {
  deviceId: "android:192.168.1.20:39457",
  platform: "android",
  kind: "physical",
  name: "Pixel 8 Pro",
  state: "online",
  osVersion: "15",
  serial: "192.168.1.20:39457",
  connection: "wifi",
  lease: null,
};

const usbPhone: MobileDevice = {
  ...wifiPhone,
  deviceId: "android:R5CT",
  name: "Galaxy S24",
  state: "unauthorized",
  serial: "R5CT",
  connection: "usb",
};

const emulator: MobileDevice = {
  deviceId: "android-avd:Pixel_8",
  platform: "android",
  kind: "emulator",
  name: "Pixel 8",
  state: "online",
  serial: "emulator-5554",
  lease: null,
};

let root: Root | undefined;

beforeAll(() => {
  globalThis.requestAnimationFrame ??= (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

function bridge(overrides: Partial<Record<"pairWifi" | "connectWifi" | "disconnectWifi", unknown>> = {}) {
  const base = {
    pairWifi: vi.fn(
      async (): Promise<MobileWifiResult> => ({
        connected: true,
        deviceId: wifiPhone.deviceId,
        message: "Paired and connected to Pixel 8 Pro.",
      }),
    ),
    connectWifi: vi.fn(
      async (): Promise<MobileWifiResult> => ({
        connected: true,
        deviceId: wifiPhone.deviceId,
        message: "Connected to Pixel 8 Pro.",
      }),
    ),
    disconnectWifi: vi.fn(async (_deviceId: string) => undefined),
  };
  return { ...base, ...overrides } as typeof base;
}

async function render(props: Partial<Parameters<typeof PhoneConnections>[0]> & { mobile: ReturnType<typeof bridge> }) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const onConnected = vi.fn();
  const onChanged = vi.fn();
  await act(async () =>
    root?.render(
      <PhoneConnections
        devices={[]}
        adbFound
        focusConnect={false}
        onConnected={onConnected}
        onChanged={onChanged}
        {...props}
      />,
    ),
  );
  return { container, onConnected, onChanged };
}

function field(container: HTMLElement, label: string): HTMLInputElement {
  const match = [...container.querySelectorAll<HTMLLabelElement>("label.field-control")].find(
    (candidate) => candidate.querySelector(".field-label")?.textContent === label,
  );
  const input = match?.querySelector("input");
  if (!input) throw new Error(`No field ${label}`);
  return input;
}

function hintFor(container: HTMLElement, label: string): string | null | undefined {
  const input = field(container, label);
  const id = input.getAttribute("aria-describedby");
  return id ? document.getElementById(id)?.textContent : undefined;
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.getAttribute("aria-label") === name || candidate.textContent?.trim() === name,
  );
  if (!match) throw new Error(`No button ${name}`);
  return match;
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(container: HTMLElement, name: string) {
  await act(async () => button(container, name).click());
}

describe("Phone connections", () => {
  it("lists only phones, says how each is connected, and disconnects the Wi-Fi one", async () => {
    const mobile = bridge();
    const { container, onChanged } = await render({ mobile, devices: [emulator, wifiPhone, usbPhone] });
    const rows = [...container.querySelectorAll<HTMLElement>('[aria-label="Phones"] > li')];
    expect(rows.map((row) => row.querySelector(".mobile-avd-name")?.textContent)).toEqual([
      "Pixel 8 Pro",
      "Galaxy S24",
    ]);
    expect(rows[0]?.textContent).toContain("Wi-Fi, 192.168.1.20:39457, Ready");
    expect(rows[1]?.textContent).toContain("USB, Waiting for approval");
    expect(rows[1]?.textContent).toContain("Allow USB debugging on the phone, then check the prompt on its screen.");
    expect(rows[1]?.querySelector("button")).toBeNull();

    await submit(container, "Disconnect Pixel 8 Pro");
    expect(mobile.disconnectWifi).toHaveBeenCalledWith(wifiPhone.deviceId);
    expect(onChanged).toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Disconnected Pixel 8 Pro.");
  });

  it("pairs with the address and code the phone shows, and hands the connected phone to the pane", async () => {
    const mobile = bridge();
    const { container, onConnected } = await render({ mobile });
    await type(field(container, "Pairing address"), " 192.168.1.20:37123 ");
    await type(field(container, "Pairing code"), "12 34-56");
    expect(field(container, "Pairing code").value).toBe("123456");
    await type(field(container, "Connect port (optional)"), "39457");
    await submit(container, "Pair and connect");
    expect(mobile.pairWifi).toHaveBeenCalledWith({
      host: "192.168.1.20",
      pairPort: 37_123,
      code: "123456",
      connectPort: 39_457,
    });
    expect(onConnected).toHaveBeenCalledWith({
      connected: true,
      deviceId: wifiPhone.deviceId,
      message: "Paired and connected to Pixel 8 Pro.",
    });
  });

  it("checks the address, port, and code before anything reaches adb", async () => {
    const mobile = bridge();
    const { container } = await render({ mobile });
    await submit(container, "Pair and connect");
    expect(hintFor(container, "Pairing address")).toBe("Enter the IP address and port, such as 192.168.1.20:37123.");
    expect(hintFor(container, "Pairing code")).toBe("Enter the 6-digit code shown on the phone.");

    await type(field(container, "Pairing address"), "192.168.1.20");
    await type(field(container, "Pairing code"), "12345");
    await type(field(container, "Connect port (optional)"), "99999");
    await submit(container, "Pair and connect");
    expect(hintFor(container, "Pairing address")).toBe("Add the port after a colon, such as 192.168.1.20:37123.");
    expect(hintFor(container, "Pairing code")).toBe("Enter the 6-digit code shown on the phone.");
    expect(hintFor(container, "Connect port (optional)")).toBe("Enter a port from 1 to 65535.");
    expect(field(container, "Pairing code").getAttribute("aria-invalid")).toBe("true");

    await type(field(container, "Pairing address"), "-s:5555");
    await submit(container, "Pair and connect");
    expect(hintFor(container, "Pairing address")).toBe("Use an IPv4 address such as 192.168.1.20, or a host name.");
    expect(mobile.pairWifi).not.toHaveBeenCalled();
  });

  it("asks for the connect port when pairing worked but the phone was not found", async () => {
    const mobile = bridge({
      pairWifi: vi.fn(
        async (): Promise<MobileWifiResult> => ({
          connected: false,
          message:
            "Paired with the phone. Enter the port under IP address & port on its Wireless debugging screen to connect.",
        }),
      ),
    });
    const { container, onChanged, onConnected } = await render({ mobile });
    await type(field(container, "Pairing address"), "192.168.1.20:37123");
    await type(field(container, "Pairing code"), "123456");
    await submit(container, "Pair and connect");
    expect(onConnected).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Paired with the phone.");
    expect(field(container, "Address").value).toBe("192.168.1.20:");

    await type(field(container, "Address"), "192.168.1.20:39457");
    await submit(container, "Connect");
    expect(mobile.connectWifi).toHaveBeenCalledWith({ host: "192.168.1.20", port: 39_457 });
    expect(onConnected).toHaveBeenCalledWith(expect.objectContaining({ deviceId: wifiPhone.deviceId }));
  });

  it("shows why adb could not pair, next to the form", async () => {
    const mobile = bridge({
      pairWifi: vi.fn(async () => {
        throw new Error(
          "Error invoking remote method 'zli:mobile:wifi-pair': MobileDriverError: The phone did not accept that code.",
        );
      }),
    });
    const { container } = await render({ mobile });
    await type(field(container, "Pairing address"), "192.168.1.20:37123");
    await type(field(container, "Pairing code"), "000000");
    await submit(container, "Pair and connect");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("The phone did not accept that code.");
  });

  it("keeps the forms disabled without adb, and focuses the first field when opened to connect a phone", async () => {
    const without = await render({ mobile: bridge(), adbFound: false });
    expect(without.container.textContent).toContain("Connecting a phone needs adb");
    expect(field(without.container, "Pairing address").disabled).toBe(true);
    expect(button(without.container, "Pair and connect").disabled).toBe(true);
    act(() => root?.unmount());

    const focused = await render({ mobile: bridge(), focusConnect: true });
    expect(document.activeElement).toBe(field(focused.container, "Pairing address"));
  });
});
