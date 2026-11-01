import { readFileSync } from "node:fs";

import type { MobileCrashReport } from "@zli-v2/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { formatMobileResult } from "../../../mobile-tool/mcp.js";
import type { AndroidDriver } from "../../AndroidDriver.js";
import { DeviceManager } from "../../DeviceManager.js";
import { FakeDriver } from "../../FakeDriver.js";
import { createMobileControlActions } from "../../MobileControlActions.js";
import { createMobileDev, type MobileDev } from "../index.js";
import { createTestDevHost } from "../testHost.js";
import { crashNotice } from "./index.js";

const crashLines = readFileSync(new URL("./fixtures/java-fatal.log", import.meta.url), "utf8").split("\n");
const firstCrash = crashLines.slice(0, 70);
const pixel = {
  deviceId: "android-avd:Pixel_7",
  platform: "android",
  kind: "emulator",
  name: "Pixel 7",
  state: "online",
  serial: "emulator-5554",
} as const;
const worktrees = [
  { worktreeId: "wt-1", path: "/repo/app", status: "ready" },
  { worktreeId: "wt-2", path: "/repo/other", status: "ready" },
];
const inApp = { cwd: "/repo/app" };
const inOther = { cwd: "/repo/other" };

let dev: MobileDev | undefined;
afterEach(async () => {
  await dev?.dispose();
  dev = undefined;
});

function setup() {
  const android = new FakeDriver("android", [pixel]);
  const devices = new DeviceManager({
    android: android as unknown as AndroidDriver,
    ios: new FakeDriver("ios", []),
    scrcpyServer: async () => "/zli/scrcpy-server",
  });
  const host = createTestDevHost({ worktrees, manager: devices });
  dev = createMobileDev(host);
  const dispatch = createMobileControlActions({
    manager: () => devices,
    worktrees: () => worktrees,
    settings: async () => host.settingsValue,
    status: async () => ({ android: { missing: [] }, ios: { supported: false, missing: [] } }) as never,
    reveal: () => undefined,
    platform: "linux",
    dev,
  });
  return { android, devices, host, dev, dispatch };
}

describe("crash watch feature", () => {
  it("joins the crash and build features into mobile dev", () => {
    const { dev } = setup();
    expect(Object.keys(dev.actions)).toEqual(expect.arrayContaining(["mobilecrashes", "mobilebuildbrief"]));
    expect(Object.keys(dev.ipc)).toEqual(
      expect.arrayContaining([
        "zli:mobile:crash:list",
        "zli:mobile:crash:dismiss",
        "zli:mobile:build:brief",
        "zli:mobile:build:propose",
      ]),
    );
    expect(Object.keys(dev.testOps)).toEqual(expect.arrayContaining(["emit-log"]));
    expect(dev.decorate).toBeDefined();
  });

  it("tells the agent holding the device about a new crash once, on its next result", async () => {
    const { dev, dispatch } = setup();
    await dispatch("mobiletap", { ...inApp, x: 1, y: 2 });
    const emitted = (await dev.testOps["emit-log"]?.({ lines: firstCrash })) as { reports: MobileCrashReport[] };
    expect(emitted.reports).toHaveLength(1);

    const next = (await dispatch("mobiletap", { ...inApp, x: 1, y: 2 })) as { crashNotice?: string };
    expect(next.crashNotice).toBe(
      "The app crashed 0 s ago: java.lang.IllegalStateException: Fragment ProfileFragment{5f2a1b} not attached to a context. Call mobile_crashes for the stack.",
    );
    expect(
      ((await dispatch("mobiletap", { ...inApp, x: 1, y: 2 })) as { crashNotice?: string }).crashNotice,
    ).toBeUndefined();
    // Another agent does not hold the device, so the crash is not its news.
    expect(((await dispatch("mobiledevices", inOther)) as { crashNotice?: string }).crashNotice).toBeUndefined();

    await dev.testOps["emit-log"]?.({ lines: crashLines.slice(70) });
    expect(((await dispatch("mobiletap", { ...inApp, x: 1, y: 2 })) as { crashNotice?: string }).crashNotice).toMatch(
      /^The app crashed/u,
    );
  });

  it("does not add a notice after mobile_crashes read the reports, and formats them for the agent", async () => {
    const { dev, dispatch } = setup();
    await dispatch("mobiletap", { ...inApp, x: 1, y: 2 });
    await dev.testOps["emit-log"]?.({ lines: crashLines });
    const result = (await dispatch("mobilecrashes", inApp)) as { reports: MobileCrashReport[]; crashNotice?: string };
    expect(result.crashNotice).toBeUndefined();
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.count).toBe(2);
    expect(
      ((await dispatch("mobiletap", { ...inApp, x: 1, y: 2 })) as { crashNotice?: string }).crashNotice,
    ).toBeUndefined();

    const text = formatMobileResult("mobilecrashes", result).content[0];
    expect(text?.type).toBe("text");
    const body = text?.type === "text" ? text.text : "";
    expect(body.split("\n")[0]).toBe(
      "com.example.app crashed: java.lang.IllegalStateException: Fragment ProfileFragment{5f2a1b} not attached to a context. (2 times, last at 2026-01-02T03:04:05.000Z)",
    );
    expect(body).toContain("\n    at androidx.fragment.app.Fragment.requireContext(Fragment.java:972)");
    expect(body).toMatch(/\nLast \d+ log lines:\n/u);
    expect(body.length).toBeLessThan(6_000);
  });

  it("adds the notice as a text line under any formatted result", () => {
    const notice = "The app crashed 3 s ago: boom. Call mobile_crashes for the stack.";
    const formatted = formatMobileResult("mobilelogs", { log: "a line", crashNotice: notice });
    expect(formatted.content.map((part) => (part.type === "text" ? part.text : ""))).toEqual(["a line", notice]);
    const json = formatMobileResult("mobiletap", { tapped: true, crashNotice: notice });
    expect(json.content).toHaveLength(1);
  });

  it("lists and dismisses a device's crashes for the panel, and pushes each change", async () => {
    const { dev, host } = setup();
    await dev.testOps["emit-log"]?.({ deviceId: pixel.deviceId, lines: firstCrash });
    const list = (await dev.ipc["zli:mobile:crash:list"]?.({ deviceId: pixel.deviceId })) as MobileCrashReport[];
    expect(list).toHaveLength(1);
    const crashId = list[0]?.crashId ?? "";
    const dismissed = (await dev.ipc["zli:mobile:crash:dismiss"]?.({
      deviceId: pixel.deviceId,
      crashId,
    })) as MobileCrashReport[];
    expect(dismissed[0]?.dismissed).toBe(true);
    expect(host.sent.filter((event) => event.channel === "zli:mobile:crash").length).toBeGreaterThanOrEqual(1);
    expect(() => dev.ipc["zli:mobile:crash:list"]?.({})).toThrow();
  });

  it("refuses mobile_crashes with no running device", async () => {
    const { dispatch, android } = setup();
    android.devices = [];
    await expect(dispatch("mobilecrashes", inApp)).rejects.toThrow(/No running device is free/u);
  });

  it("says how long ago a crash was", () => {
    const report = { title: "TypeError: x is undefined", lastSeen: "2026-01-02T03:00:00.000Z" } as MobileCrashReport;
    expect(crashNotice(report, new Date("2026-01-02T03:00:12.000Z"))).toBe(
      "The app crashed 12 s ago: TypeError: x is undefined. Call mobile_crashes for the stack.",
    );
    expect(crashNotice(report, new Date("2026-01-02T03:05:00.000Z"))).toContain("crashed 5 min ago");
  });
});
