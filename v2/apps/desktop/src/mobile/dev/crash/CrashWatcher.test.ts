import { readFileSync } from "node:fs";

import type { MobileCrashEvent, MobileDevice, MobileLease, MobileSettings } from "@zli-v2/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AndroidDriver } from "../../AndroidDriver.js";
import { type FakeProcess, FakeProcessRunner } from "../../FakeProcessRunner.js";
import { type DriverDevice, type LogStream, type MobileDriver, processLogStream } from "../../MobileDriver.js";
import { type CrashWatchManager, CrashWatcher, tailFor } from "./CrashWatcher.js";

const crashLines = readFileSync(new URL("./fixtures/java-fatal.log", import.meta.url), "utf8").split("\n");

const device: MobileDevice = {
  deviceId: "android-avd:Pixel_7",
  platform: "android",
  kind: "emulator",
  name: "Pixel 7",
  state: "online",
  serial: "emulator-5554",
  lease: null,
} as MobileDevice;

const agentLease = { ownerId: "agent:wt-1", ownerLabel: "The agent in app", kind: "agent" } as MobileLease;

function setup(options: { lease?: MobileLease | null; viewers?: number; settings?: MobileSettings } = {}) {
  const runner = new FakeProcessRunner();
  const state = {
    devices: [device],
    lease: options.lease === undefined ? agentLease : options.lease,
    viewers: options.viewers ?? 0,
    settings: options.settings ?? { agentTools: true, crashWatch: true },
    streamError: undefined as Error | undefined,
  };
  const driver = {
    streamLogs: async (target: DriverDevice): Promise<LogStream> => {
      if (state.streamError) throw state.streamError;
      return processLogStream(runner.spawn("adb", ["-s", target.serial ?? "", "logcat"]));
    },
  } as unknown as MobileDriver;
  const manager: CrashWatchManager = {
    cached: () => state.devices,
    viewerCount: () => state.viewers,
    driverFor: () => driver,
    leases: { get: () => state.lease, heldBy: () => [] },
  };
  const sent: MobileCrashEvent[] = [];
  const log = vi.fn();
  const watcher = new CrashWatcher({
    manager: () => manager,
    settings: async () => state.settings,
    send: (_channel, payload) => sent.push(payload),
    now: () => Date.now(),
    log,
  });
  const process = (index = runner.spawned.length - 1): FakeProcess => {
    const found = runner.spawned[index];
    if (!found) throw new Error("No log process");
    return found;
  };
  return { runner, state, watcher, sent, log, process };
}

/** Lets the stream's exit and the restart timers run. */
async function settle(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-02T03:04:05.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("crash watcher", () => {
  it("reads the log while an agent holds the device, across chunks split mid-line", async () => {
    const { watcher, runner, process, sent } = setup();
    await watcher.tick();
    expect(runner.spawned).toHaveLength(1);
    const text = `${crashLines.slice(0, 70).join("\n")}\n`;
    process().emit(text.slice(0, 2_001));
    process().emit(text.slice(2_001));
    await settle(600);
    const reports = watcher.reports(device.deviceId);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      kind: "java",
      appId: "com.example.app",
      title: "java.lang.IllegalStateException: Fragment ProfileFragment{5f2a1b} not attached to a context.",
      count: 1,
      heldBy: "The agent in app",
    });
    expect(sent).toHaveLength(1);
    watcher.dispose();
  });

  it("starts for a window showing the device, and not for a device nobody uses or with the setting off", async () => {
    const idle = setup({ lease: null });
    await idle.watcher.tick();
    expect(idle.runner.spawned).toHaveLength(0);
    idle.state.viewers = 1;
    await idle.watcher.tick();
    expect(idle.runner.spawned).toHaveLength(1);
    idle.watcher.dispose();

    const off = setup({ settings: { agentTools: true, crashWatch: false } });
    await off.watcher.tick();
    expect(off.runner.spawned).toHaveLength(0);
  });

  it("stops when the setting goes off, the device goes offline, or two minutes pass unused", async () => {
    const { watcher, state, process } = setup();
    await watcher.tick();
    state.settings = { agentTools: true, crashWatch: false };
    await watcher.tick();
    expect(process(0).killed).toBe(true);

    state.settings = { agentTools: true, crashWatch: true };
    await watcher.tick();
    state.devices = [{ ...device, state: "offline" } as MobileDevice];
    await watcher.tick();
    expect(process(1).killed).toBe(true);

    state.devices = [device];
    await watcher.tick();
    state.lease = null;
    await settle(119_000);
    await watcher.tick();
    expect(process(2).killed).toBe(false);
    await settle(1_000);
    await watcher.tick();
    expect(process(2).killed).toBe(true);
  });

  it("restarts a dead stream after 1, 5, and 15 seconds, then gives up", async () => {
    const { watcher, runner, process, log } = setup();
    await watcher.tick();
    for (const delay of [1_000, 5_000, 15_000]) {
      process().exit(1);
      await settle(delay - 1);
      const before = runner.spawned.length;
      await settle(1);
      expect(runner.spawned.length).toBe(before + 1);
    }
    process().exit(1);
    await settle(60_000);
    await watcher.tick();
    expect(runner.spawned).toHaveLength(4);
    expect(log).toHaveBeenCalledWith("The log of Pixel 7 stopped 4 times, so crash watch is off for it.");
  });

  it("logs once and stays off for a device whose log cannot be read", async () => {
    const { watcher, state, log, runner } = setup();
    state.streamError = new Error("adb is missing");
    await watcher.tick();
    await watcher.tick();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("adb is missing");
    expect(runner.spawned).toHaveLength(0);
  });

  it("tries the log again after the device reconnects", async () => {
    const { watcher, state, runner } = setup();
    state.streamError = new Error("adb is missing");
    await watcher.tick();
    expect(runner.spawned).toHaveLength(0);
    state.streamError = undefined;
    // Still marked unreadable while the device stays as it was.
    await watcher.tick();
    expect(runner.spawned).toHaveLength(0);
    state.devices = [{ ...device, state: "offline" } as MobileDevice];
    await watcher.tick();
    state.devices = [device];
    await watcher.tick();
    expect(runner.spawned).toHaveLength(1);
    watcher.dispose();
  });

  it("sends at most one event a second per device, then one with the latest reports", async () => {
    const { watcher, process, sent } = setup();
    await watcher.tick();
    process().emit(`${crashLines.slice(0, 63).join("\n")}\n`);
    expect(sent).toHaveLength(1);
    process().emit(`${crashLines.slice(63).join("\n")}\n`);
    await settle(600);
    expect(sent).toHaveLength(1);
    await settle(400);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.reports[0]?.count).toBe(2);
    watcher.dispose();
  });

  it("keeps the 30 lines before a crash as its tail, without the frames", () => {
    const ring = Array.from({ length: 500 }, (_, index) => `noise ${index}`);
    const block = [
      "E AndroidRuntime: FATAL EXCEPTION: main",
      "E AndroidRuntime: java.lang.RuntimeException: boom",
      "E AndroidRuntime: \tat com.example.app.Main.run(Main.kt:1)",
    ];
    ring.push(...block);
    const tail = tailFor(ring, block);
    expect(tail).toHaveLength(30);
    expect(tail.at(-1)).toBe(block[1]);
    expect(tail[0]).toBe("noise 472");
    expect(tail.some((line) => line.includes("Main.kt"))).toBe(false);
  });
});

describe("Android log stream", () => {
  it("follows logcat from now on, with the main, system, and crash buffers", async () => {
    const runner = new FakeProcessRunner();
    const android = new AndroidDriver({
      runner,
      tools: async () => ({
        adb: "/sdk/platform-tools/adb",
        emulator: "/sdk/emulator/emulator",
        env: { ANDROID_HOME: "/sdk" },
        avds: [],
      }),
      sleep: async () => undefined,
      now: () => 0,
    });
    const stream = await android.streamLogs({
      deviceId: "android-avd:Pixel_7",
      platform: "android",
      kind: "emulator",
      name: "Pixel 7",
      state: "online",
      serial: "emulator-5554",
    });
    const spawned = runner.spawned[0];
    expect(spawned?.command).toBe("/sdk/platform-tools/adb");
    expect(spawned?.args).toEqual([
      "-s",
      "emulator-5554",
      "logcat",
      "-v",
      "threadtime",
      "-T",
      "1",
      "-b",
      "main",
      "-b",
      "system",
      "-b",
      "crash",
    ]);
    expect(runner.calls[0]?.options).toMatchObject({ env: { ANDROID_HOME: "/sdk" } });
    const lines: string[] = [];
    stream.onLine((line) => lines.push(line));
    spawned?.emit("first li");
    spawned?.emit("ne\r\nsecond\nthi");
    expect(lines).toEqual(["first line", "second"]);
    spawned?.exit(0);
    await stream.exited;
    expect(lines).toEqual(["first line", "second", "thi"]);
    stream.stop();
    expect(spawned?.killed).toBe(true);
  });
});
