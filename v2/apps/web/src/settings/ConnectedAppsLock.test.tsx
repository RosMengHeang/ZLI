// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PresenceStatus } from "../runtime/bridge.js";
import { ConnectedAppsLock } from "./ConnectedAppsLock.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

function security(status: PresenceStatus["status"], onResult: PresenceStatus = { status: "on" }) {
  return {
    presenceStatus: vi.fn(async (): Promise<PresenceStatus> => ({ status })),
    turnOnPresence: vi.fn(async () => onResult),
    turnOffPresence: vi.fn(async (): Promise<PresenceStatus> => ({ status: "off" })),
  };
}

async function show(bridge: ReturnType<typeof security> | undefined) {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root?.render(<ConnectedAppsLock security={bridge} />));
  return host;
}

const toggle = () => host?.querySelector<HTMLInputElement>('input[role="switch"]');

describe("ConnectedAppsLock", () => {
  it("is hidden off Windows and outside the desktop app", async () => {
    expect((await show(security("unsupported"))).textContent).toBe("");
    act(() => root?.unmount());
    expect((await show(undefined)).textContent).toBe("");
  });

  it("is disabled with a note when Windows Hello isn't set up", async () => {
    const view = await show(security("unavailable"));
    expect(view.textContent).toContain("Set up Windows Hello in Windows Settings to use this.");
    expect(toggle()?.disabled).toBe(true);
  });

  it("turns on and off through the desktop app", async () => {
    const bridge = security("off");
    await show(bridge);
    await act(async () => toggle()?.click());
    expect(bridge.turnOnPresence).toHaveBeenCalledOnce();
    expect(toggle()?.checked).toBe(true);
    await act(async () => toggle()?.click());
    expect(bridge.turnOffPresence).toHaveBeenCalledOnce();
    expect(toggle()?.checked).toBe(false);
  });

  it("stays off and says why when the Hello prompt is cancelled", async () => {
    const bridge = security("off", { status: "off", error: "Windows Hello didn't confirm it was you, so this stays off." });
    await show(bridge);
    await act(async () => toggle()?.click());
    expect(toggle()?.checked).toBe(false);
    expect(host?.querySelector('[role="alert"]')?.textContent).toContain("didn't confirm it was you");
  });
});
