// @vitest-environment jsdom

import type { MobileAccessStatus } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  push: false,
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

const relayOff: MobileAccessStatus["relay"] = {
  available: true,
  enabled: false,
  state: "off",
  remoteTerminalInput: false,
};

/** Fixtures leave out the relay unless a test is about it. */
type StatusFixture = Omit<MobileAccessStatus, "relay"> & { relay?: Partial<MobileAccessStatus["relay"]> };

function withRelay(status: StatusFixture): MobileAccessStatus {
  return { ...status, relay: { ...relayOff, ...status.relay } };
}

function fakeBridge(initial: StatusFixture) {
  let listener: ((status: MobileAccessStatus) => void) | undefined;
  let current = withRelay(initial);
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
    setRelayEnabled: vi.fn(async (enabled: boolean) => {
      current = {
        ...current,
        relay: {
          ...current.relay,
          enabled,
          state: enabled ? "connecting" : "off",
          remoteTerminalInput: enabled && current.relay.remoteTerminalInput,
        },
      };
      return current;
    }),
    setRemoteTerminalInput: vi.fn(async (enabled: boolean) => {
      current = { ...current, relay: { ...current.relay, remoteTerminalInput: enabled } };
      return current;
    }),
    respondToPairing: vi.fn(async (_id: string, _allow: boolean) => {
      const { pairingRequest: _request, ...rest } = current;
      current = rest;
      return current;
    }),
    retryRelay: vi.fn(async () => {
      current = { ...current, relay: { ...current.relay, state: "connecting" } };
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
    push(status: StatusFixture) {
      current = withRelay(status);
      listener?.(current);
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

function toggle(root: ParentNode, label: string): HTMLInputElement {
  const found = [...root.querySelectorAll<HTMLLabelElement>("label.switch-row")].find(
    (row) => row.querySelector(".switch-label")?.textContent === label,
  );
  const input = found?.querySelector<HTMLInputElement>('input[role="switch"]');
  if (!input) throw new Error(`No switch ${label}`);
  return input;
}

function hasSwitch(root: ParentNode, label: string): boolean {
  return [...root.querySelectorAll(".switch-label")].some((node) => node.textContent === label);
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

  it("says which phones get alerts while the app is closed", async () => {
    fakeBridge({
      enabled: true,
      state: "listening",
      hosts: ["10.0.0.2"],
      port: 47321,
      devices: [pixel, { ...pixel, deviceId: "d2", name: "iPhone", push: true }],
    });
    const container = await render();
    const rows = [...container.querySelectorAll(".mobile-device-row")].map((row) => row.textContent ?? "");
    expect(rows.find((row) => row.includes("iPhone"))).toContain("Gets alerts while ZLI Remote is closed");
    expect(rows.find((row) => row.includes("Pixel 9"))).not.toContain("Gets alerts");
  });

  it("shows a load failure with a way to try again", async () => {
    const bridge = fakeBridge({ enabled: false, state: "off", hosts: [], devices: [] });
    bridge.api.getStatus.mockRejectedValueOnce(new Error("Main process is busy."));
    const container = await render();
    expect(container.textContent).toContain("Main process is busy.");
    await act(async () => button(container, "Try again").click());
    expect(container.textContent).toContain("Allow phones on this network");
  });

  describe("a pairing that came through the relay", () => {
    const listening: StatusFixture = {
      enabled: true,
      state: "listening",
      hosts: ["10.0.0.2"],
      port: 47321,
      devices: [],
      relay: { enabled: true, state: "online" },
    };
    const request = (seconds: number) => ({
      id: "req-1",
      deviceName: "Pixel 9",
      code: "042917",
      expiresAt: new Date(Date.now() + seconds * 1_000).toISOString(),
    });

    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Allow turns on a second after the request shows, so waiting that long is part of every answer. */
    async function settle() {
      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
    }

    it("asks before the phone pairs, with the time left, and allows it with the request id", async () => {
      const bridge = fakeBridge(listening);
      const container = await render();
      await act(async () => button(container, "Pair a new phone").click());
      // The phone used the code; the desktop now waits on the person.
      await act(async () => bridge.push({ ...listening, pairingRequest: request(90) }));
      expect(container.textContent).toContain('Allow "Pixel 9" to control this PC from anywhere?');
      expect(container.textContent).toMatch(/1:[23]\d/u);
      expect(container.textContent).not.toContain("expired or was already used");
      // The name is isolated, so its text direction cannot reorder the question around it.
      expect(container.querySelector("bdi")?.textContent).toBe("Pixel 9");
      // The same code shows on the phone, so the person can tell their phone from someone else's.
      expect(container.querySelector(".mobile-confirm-code")?.textContent).toBe("042 917");
      expect(container.textContent).toContain("Allow only if your phone shows this code.");

      await settle();
      await act(async () => button(container, "Allow").click());
      expect(bridge.api.respondToPairing).toHaveBeenCalledWith("req-1", true);
      await act(async () => bridge.push({ ...listening, devices: [{ ...pixel, connected: true }] }));
      expect(container.textContent).toContain("Paired with Pixel 9.");
    });

    it("refuses with the request id and says the phone was not paired", async () => {
      const bridge = fakeBridge(listening);
      const container = await render();
      await act(async () => button(container, "Pair a new phone").click());
      await act(async () => bridge.push({ ...listening, pairingRequest: request(90) }));
      await act(async () => button(container, "Don't allow").click());
      expect(bridge.api.respondToPairing).toHaveBeenCalledWith("req-1", false);
      expect(container.textContent).not.toContain("to control this PC from anywhere?");
      expect(container.textContent).toContain("The phone was not paired. Make a new code to try again.");
    });

    it("keeps Allow off for a second after the request shows, so a click meant for the code cannot land on it", async () => {
      const bridge = fakeBridge(listening);
      const container = await render();
      await act(async () => bridge.push({ ...listening, pairingRequest: request(90) }));
      expect(button(container, "Allow").disabled).toBe(true);
      expect(button(container, "Don't allow").disabled).toBe(false);
      await act(async () => {
        vi.advanceTimersByTime(999);
      });
      expect(button(container, "Allow").disabled).toBe(true);
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(button(container, "Allow").disabled).toBe(false);
    });

    it("says the phone was not paired when an allowed phone never shows up", async () => {
      const bridge = fakeBridge(listening);
      const container = await render();
      await act(async () => button(container, "Pair a new phone").click());
      await act(async () => bridge.push({ ...listening, pairingRequest: request(90) }));
      await settle();
      await act(async () => button(container, "Allow").click());
      // The phone left before the desktop stored it.
      await act(async () => bridge.push(listening));
      expect(container.textContent).not.toContain("The phone was not paired");
      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });
      expect(container.textContent).toContain("The phone was not paired. Make a new code to try again.");
      // It does not stick: a phone that shows up later is not reported as paired by this code.
      await act(async () => bridge.push({ ...listening, devices: [pixel] }));
      expect(container.textContent).not.toContain("Paired with");
    });
  });

  describe("connect from anywhere", () => {
    const listening: StatusFixture = {
      enabled: true,
      state: "listening",
      hosts: ["10.0.0.2"],
      port: 47321,
      devices: [],
    };

    it("is off by default and turns on through the bridge, then shows the relay status", async () => {
      const bridge = fakeBridge(listening);
      const container = await render();
      const relaySwitch = toggle(container, "Connect from anywhere");
      expect(relaySwitch.checked).toBe(false);
      expect(relaySwitch.disabled).toBe(false);
      expect(container.textContent).toContain(
        "Your phone reaches this PC through your relay when it isn't on the same Wi-Fi. The relay can't read your traffic, but it sees when each side connects and from which network address.",
      );
      expect(container.textContent).not.toContain("stops paired phones");
      expect(hasSwitch(container, "Allow terminal input from anywhere")).toBe(false);

      await act(async () => relaySwitch.click());
      expect(bridge.api.setRelayEnabled).toHaveBeenCalledWith(true);
      expect(container.textContent).toContain("Connecting…");
      expect(container.textContent).toContain(
        "Turning it off stops paired phones from using the relay. Turned back on, it gets a new address, which each phone picks up the next time it connects on the same network.",
      );
      expect(toggle(container, "Allow terminal input from anywhere").checked).toBe(false);

      await act(async () => bridge.push({ ...listening, relay: { enabled: true, state: "online" } }));
      expect(container.textContent).toContain("Online");
      await act(async () => bridge.push({ ...listening, relay: { enabled: true, state: "offline" } }));
      expect(container.textContent).toContain("Offline, retrying");
      await act(async () => bridge.push({ ...listening, relay: { enabled: true, state: "budget-exhausted" } }));
      expect(container.textContent).toContain("Daily relay limit reached, retrying tomorrow");
    });

    it("turns terminal input from anywhere on through the bridge, and hides it once the relay is off", async () => {
      const bridge = fakeBridge({ ...listening, relay: { enabled: true, state: "online" } });
      const container = await render();
      await act(async () => toggle(container, "Allow terminal input from anywhere").click());
      expect(bridge.api.setRemoteTerminalInput).toHaveBeenCalledWith(true);
      expect(toggle(container, "Allow terminal input from anywhere").checked).toBe(true);

      await act(async () => toggle(container, "Connect from anywhere").click());
      expect(bridge.api.setRelayEnabled).toHaveBeenCalledWith(false);
      expect(hasSwitch(container, "Allow terminal input from anywhere")).toBe(false);
      expect(container.textContent).not.toContain("Online");
    });

    it("explains when another PC holds the pairing and dials again on request", async () => {
      const bridge = fakeBridge({ ...listening, relay: { enabled: true, state: "replaced" } });
      const container = await render();
      expect(container.textContent).toContain(
        "Another PC is using this pairing. Taking it back disconnects that PC from the relay.",
      );
      await act(async () => button(container, "Take it back").click());
      expect(bridge.api.retryRelay).toHaveBeenCalled();
      expect(container.textContent).toContain("Connecting…");
    });

    it("shows why the relay could not start next to its switch", async () => {
      fakeBridge({
        ...listening,
        relay: { enabled: true, state: "off", errorMessage: "Connect from anywhere could not start: bad route" },
      });
      const container = await render();
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "Connect from anywhere could not start: bad route",
      );
      expect(container.textContent).toContain("10.0.0.2:47321");
    });

    it("shows the switch turned off when this build has no relay set up", async () => {
      fakeBridge({ ...listening, relay: { available: false } });
      const container = await render();
      const relaySwitch = toggle(container, "Connect from anywhere");
      expect(relaySwitch.disabled).toBe(true);
      expect(container.textContent).toContain("This build has no relay set up.");
    });
  });
});
