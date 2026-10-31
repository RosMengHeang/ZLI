import { describe, expect, it } from "vitest";

import { bringToFront, claimSingleInstance, type InstanceWindow } from "./SingleInstance.js";

function fakeApp(locked: boolean) {
  const listeners: Array<() => void> = [];
  return {
    listeners,
    requestSingleInstanceLock: () => locked,
    on: (_event: "second-instance", listener: () => void) => listeners.push(listener),
  };
}

function fakeWindow(state: { minimized?: boolean; destroyed?: boolean } = {}) {
  const calls: string[] = [];
  const window: InstanceWindow = {
    isDestroyed: () => state.destroyed ?? false,
    isMinimized: () => state.minimized ?? false,
    restore: () => calls.push("restore"),
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
  };
  return { window, calls };
}

describe("claimSingleInstance", () => {
  it("tells a later launch to exit and listens for nothing", () => {
    const app = fakeApp(false);
    expect(claimSingleInstance(app, () => undefined)).toBe(false);
    expect(app.listeners).toHaveLength(0);
  });

  it("brings the first window forward when another launch is attempted", () => {
    const app = fakeApp(true);
    const { window, calls } = fakeWindow({ minimized: true });
    expect(claimSingleInstance(app, () => window)).toBe(true);
    expect(calls).toEqual([]);
    for (const listener of app.listeners) listener();
    expect(calls).toEqual(["restore", "show", "focus"]);
  });

  it("finds the window at the time of the launch, not when the lock was taken", () => {
    const app = fakeApp(true);
    let current: InstanceWindow | undefined;
    claimSingleInstance(app, () => current);
    for (const listener of app.listeners) listener();
    const { window, calls } = fakeWindow();
    current = window;
    for (const listener of app.listeners) listener();
    expect(calls).toEqual(["show", "focus"]);
  });
});

describe("bringToFront", () => {
  it("leaves a closed window alone", () => {
    const { window, calls } = fakeWindow({ destroyed: true, minimized: true });
    bringToFront(window);
    expect(calls).toEqual([]);
  });
});
