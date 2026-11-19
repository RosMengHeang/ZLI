import type { RuntimeProjection } from "@zli-v2/contracts";
import { describe, expect, it, vi } from "vitest";

import { TrayController, type TrayMenuItem } from "./TrayController.js";

const routine = (paused: boolean) => ({
  routineId: "r1",
  buddyId: "b1",
  projectId: "p1",
  goal: "Run tests",
  trigger: { kind: "schedule", cron: "0 9 * * 1-5" },
  paused,
  failuresInRow: 0,
  seen: [],
  createdAt: "2026-11-15T09:00:00.000Z",
});
const state = (paused: boolean) => ({ routines: [routine(paused)], tasks: [] }) as unknown as RuntimeProjection;

function setup() {
  let menu: readonly TrayMenuItem[] = [];
  const tray = {
    setToolTip: vi.fn(),
    setMenu: (items: readonly TrayMenuItem[]) => {
      menu = items;
    },
    onClick: vi.fn(),
    notify: vi.fn(),
    destroy: vi.fn(),
  };
  const host = {
    createTray: vi.fn(() => tray),
    showWindow: vi.fn(),
    hideWindow: vi.fn(),
    quit: vi.fn(),
    command: vi.fn(async () => ({})),
  };
  return { controller: new TrayController(host), host, tray, menu: () => menu };
}

describe("TrayController", () => {
  it("hides to the tray on close only while a routine is on", () => {
    const { controller, host, tray } = setup();
    controller.update(state(true));
    expect(controller.hideOnClose()).toBe(false);
    controller.update(state(false));
    expect(controller.hideOnClose()).toBe(true);
    expect(host.hideWindow).toHaveBeenCalledOnce();
    expect(tray.notify).toHaveBeenCalledOnce();
    controller.update(state(true));
    expect(tray.destroy).toHaveBeenCalled();
    expect(controller.active).toBe(false);
  });

  it("quits from the tray menu", () => {
    const { controller, host, menu } = setup();
    controller.update(state(false));
    const quit = menu().find((item) => "label" in item && item.label === "Quit ZLI");
    if (!quit || !("click" in quit)) throw new Error("No quit item");
    quit.click?.();
    expect(host.quit).toHaveBeenCalledOnce();
  });
});
