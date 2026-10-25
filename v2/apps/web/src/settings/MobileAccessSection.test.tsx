// @vitest-environment jsdom

import type { MobileAccessStatus } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { MobileAccessSection } from "./MobileAccessSection.js";
import { countdown, deviceDetail, newlyPaired, qrPath } from "./mobileAccessView.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.replaceChildren();
  delete (window as { zli?: ZliBridge }).zli;
});

const pixel = {
  deviceId: "d1",
  name: "Pixel 9",
  pairedAt: "2026-03-02T10:00:00.000Z",
  connected: false,
} as const;

describe("mobile access helpers", () => {
  it("draws a square QR code with dark modules", () => {
    const { size, path } = qrPath("zli-remote:abc");
    expect(size).toBeGreaterThanOrEqual(21);
    expect(path).toMatch(/^M0 0h7v1h-7z/u);
    expect(qrPath("zli-remote:abc").path).toBe(path);
  });

  it("counts down in minutes and seconds and stops at zero", () => {
    const expiresAt = "2026-03-02T10:05:00.000Z";
    expect(countdown(expiresAt, Date.parse("2026-03-02T10:00:00.000Z"))).toBe("5:00");
    expect(countdown(expiresAt, Date.parse("2026-03-02T10:04:55.500Z"))).toBe("0:05");
    expect(countdown(expiresAt, Date.parse("2026-03-02T10:06:00.000Z"))).toBe("0:00");
  });

  it("describes when a phone paired and was last seen", () => {
    const now = Date.parse("2026-03-02T12:00:00.000Z");
    expect(deviceDetail({ ...pixel, connected: true }, now)).toMatch(/^Paired .+\. Connected now\.$/u);
    expect(deviceDetail({ ...pixel, lastSeenAt: "2026-03-02T11:55:00.000Z" }, now)).toMatch(/Last seen 5 min ago\.$/u);
    expect(deviceDetail({ ...pixel, lastSeenAt: "2026-03-02T11:59:40.000Z" }, now)).toMatch(/Last seen just now\.$/u);
    expect(deviceDetail(pixel, now)).toMatch(/^Paired [^.]+\.$/u);
  });

  it("finds the phone a pairing added", () => {
    const other = { ...pixel, deviceId: "d2", name: "iPhone" };
    expect(newlyPaired([pixel], [pixel, other])).toEqual(other);
    expect(newlyPaired([pixel], [pixel])).toBeUndefined();
  });
});

function fakeBridge(initial: MobileAccessStatus) {
  let listener: ((status: MobileAccessStatus) => void) | undefined;
  let current = initial;
  const api = {
    getStatus: vi.fn(async () => current),
    setEnabled: vi.fn(async (enabled: boolean) => {
      current = { ...current, enabled, state: enabled ? "listening" : "off", ...(enabled ? { port: 47321 } : {}) };
      return current;
    }),
    startPairing: vi.fn(async () => {
      current = {
        ...current,
        pairing: { code: "zli-remote:test", expiresAt: new Date(Date.now() + 300_000).toISOString() },
      };
      return current;
    }),
    cancelPairing: vi.fn(async () => {
      const { pairing: _pairing, ...rest } = current;
      current = rest;
      return current;
    }),
    revoke: vi.fn(async (deviceId: string) => {
      current = { ...current, devices: current.devices.filter((device) => device.deviceId !== deviceId) };
      return current;
    }),
    onStatus: (next: (status: MobileAccessStatus) => void) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  };
  (window as { zli?: unknown }).zli = { mobileAccess: api };
  return {
    api,
    push(status: MobileAccessStatus) {
      current = status;
      listener?.(status);
    },
  };
}

async function render() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<MobileAccessSection />));
  return container;
}

function button(root: ParentNode, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`No button ${label}`);
  return found;
}

describe("MobileAccessSection", () => {
  it("explains that phone access needs the desktop app", async () => {
    const container = await render();
    expect(container.textContent).toContain("available in the ZLI desktop app only");
  });

  it("turns phone access on, pairs a phone, and confirms which one paired", async () => {
    const bridge = fakeBridge({ enabled: false, state: "off", hosts: [], devices: [] });
    const container = await render();
    expect(container.textContent).toContain("No phones are paired. Turn on phone access to pair one.");
    expect(container.textContent).not.toContain("Pair a new phone");

    const toggle = container.querySelector<HTMLInputElement>('input[role="switch"]');
    await act(async () => toggle?.click());
    expect(bridge.api.setEnabled).toHaveBeenCalledWith(true);
    await act(async () =>
      bridge.push({ enabled: true, state: "listening", hosts: ["192.168.1.20"], port: 47321, devices: [] }),
    );
    expect(container.textContent).toContain("192.168.1.20:47321");

    await act(async () => button(container, "Pair a new phone").click());
    expect(container.querySelector('svg[aria-label="Pairing QR code"]')).not.toBeNull();
    expect(container.textContent).toMatch(/Expires in [45]:\d\d/u);

    await act(async () =>
      bridge.push({
        enabled: true,
        state: "listening",
        hosts: ["192.168.1.20"],
        port: 47321,
        devices: [{ ...pixel, connected: true }],
      }),
    );
    expect(container.textContent).toContain("Paired with Pixel 9.");
    expect(container.querySelector('svg[aria-label="Pairing QR code"]')).toBeNull();
  });

  it("says when a code ends without a phone pairing", async () => {
    const bridge = fakeBridge({ enabled: true, state: "listening", hosts: ["10.0.0.2"], port: 47321, devices: [] });
    const container = await render();
    await act(async () => button(container, "Pair a new phone").click());
    await act(async () =>
      bridge.push({ enabled: true, state: "listening", hosts: ["10.0.0.2"], port: 47321, devices: [] }),
    );
    expect(container.textContent).toContain("The pairing code expired or was already used.");
  });

  it("asks before revoking a phone", async () => {
    const bridge = fakeBridge({
      enabled: true,
      state: "listening",
      hosts: ["10.0.0.2"],
      port: 47321,
      devices: [pixel],
    });
    const container = await render();
    await act(async () => button(container, "Revoke Pixel 9").click());
    expect(bridge.api.revoke).not.toHaveBeenCalled();
    await act(async () => button(container, "Remove Pixel 9 for good").click());
    expect(bridge.api.revoke).toHaveBeenCalledWith("d1");
    expect(container.textContent).toContain("No phones are paired yet.");
  });

  it("shows a load failure with a way to try again", async () => {
    const bridge = fakeBridge({ enabled: false, state: "off", hosts: [], devices: [] });
    bridge.api.getStatus.mockRejectedValueOnce(new Error("Main process is busy."));
    const container = await render();
    expect(container.textContent).toContain("Main process is busy.");
    await act(async () => button(container, "Try again").click());
    expect(container.textContent).toContain("Allow phones on this network");
  });
});
