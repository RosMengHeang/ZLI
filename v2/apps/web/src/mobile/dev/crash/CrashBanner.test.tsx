// @vitest-environment jsdom

import type { MobileCrashEvent, MobileCrashReport } from "@zli-v2/contracts";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CrashBanner, crashCardText } from "./CrashBanner.js";
import { button, cleanup, click, devContext, pixel, render, testRuntime } from "./testRender.js";

const report: MobileCrashReport = {
  crashId: "crash-1",
  deviceId: pixel.deviceId,
  appId: "com.example.app",
  kind: "java",
  title: "java.lang.IllegalStateException: Fragment not attached",
  frames: ["at com.example.app.Profile.load(Profile.kt:12)", "at android.os.Handler.dispatch(Handler.java:1)"],
  tail: ["I ActivityManager: Start proc", "E AndroidRuntime: FATAL EXCEPTION: main"],
  firstSeen: "2026-01-02T03:04:05.000Z",
  lastSeen: "2026-01-02T03:04:09.000Z",
  count: 3,
};

function fakeCrash(initial: MobileCrashReport[]) {
  const listeners = new Set<(event: MobileCrashEvent) => void>();
  let list = initial;
  const crash = {
    list: vi.fn(async () => list),
    dismiss: vi.fn(async (_deviceId: string, crashId: string) => {
      list = list.map((entry) => (entry.crashId === crashId ? { ...entry, dismissed: true } : entry));
      return list;
    }),
    onChange: (listener: (event: MobileCrashEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const push = (event: MobileCrashEvent) =>
    act(() => {
      for (const listener of listeners) listener(event);
    });
  return { crash, push };
}

afterEach(cleanup);

describe("crash banner", () => {
  it("shows the newest crash with its count, and its frames and tail under Show details", async () => {
    const { crash } = fakeCrash([report]);
    const runtime = testRuntime();
    const container = await render(<CrashBanner context={devContext({ crash })} />, runtime.bridge);
    expect(crash.list).toHaveBeenCalledWith(pixel.deviceId);
    expect(container.querySelector(".banner-message")?.textContent).toBe(
      "com.example.app crashed: IllegalStateException: Fragment not attached ×3",
    );
    expect(container.querySelector("pre")).toBeNull();
    await click(button(container, "Show details"));
    const details = container.querySelector("pre")?.textContent ?? "";
    expect(details).toContain("  at com.example.app.Profile.load(Profile.kt:12)");
    expect(details).toContain("E AndroidRuntime: FATAL EXCEPTION: main");
  });

  it("sends the report to the worktree's agent and says so", async () => {
    const { crash } = fakeCrash([report]);
    const runtime = testRuntime();
    const context = devContext({ crash });
    const container = await render(<CrashBanner context={context} />, runtime.bridge);
    await click(button(container, "Send to agent"));
    expect(runtime.commands).toEqual([{ type: "thread.send", threadId: "t-1", text: crashCardText(report) }]);
    expect(crashCardText(report)).toContain("Caught by ZLI from the device log.");
    expect(context.onNotice).toHaveBeenCalledWith("Sent to the agent in feat-login");
  });

  it("disables Send to agent when no chat agent works in the worktree", async () => {
    const { crash } = fakeCrash([report]);
    const container = await render(<CrashBanner context={devContext({ crash })} />, testRuntime(false).bridge);
    const send = button(container, "Send to agent");
    expect(send.disabled).toBe(true);
    expect(send.closest("[data-tooltip]")?.getAttribute("data-tooltip") ?? send.getAttribute("data-tooltip")).toBe(
      "No chat agent works in this worktree",
    );
  });

  it("goes away on Dismiss and comes back when the crash repeats", async () => {
    const { crash, push } = fakeCrash([report]);
    const container = await render(<CrashBanner context={devContext({ crash })} />, testRuntime().bridge);
    await click(button(container, "Dismiss crash"));
    expect(crash.dismiss).toHaveBeenCalledWith(pixel.deviceId, "crash-1");
    expect(container.querySelector(".mobile-crash")).toBeNull();
    push({ deviceId: "other", reports: [{ ...report, deviceId: "other" }] });
    expect(container.querySelector(".mobile-crash")).toBeNull();
    push({ deviceId: pixel.deviceId, reports: [{ ...report, count: 4, dismissed: false }] });
    expect(container.textContent).toContain("×4");
  });

  it("shows nothing without a device or a crash", async () => {
    const { crash } = fakeCrash([]);
    const container = await render(<CrashBanner context={devContext({ crash })} />, testRuntime().bridge);
    expect(container.textContent).toBe("");
    cleanup();
    const none = await render(
      <CrashBanner context={devContext({ crash }, { device: undefined })} />,
      testRuntime().bridge,
    );
    expect(none.textContent).toBe("");
  });
});
