import { crc32, deflateSync } from "node:zlib";

import {
  type MobileAndroidStatus,
  type MobileAvdList,
  type MobileSetupPlan,
  type MobileSetupProgress,
  MobileTestFetchAnswer,
  MobileTestRunnerAnswer,
} from "@zli-v2/contracts";

import type { AndroidDriver } from "../AndroidDriver.js";
import type { AndroidEnvironment, AndroidSetup } from "../AndroidSetup.js";
import { AndroidWireless } from "../AndroidWireless.js";
import type { AvdManager } from "../AvdManager.js";
import { DeviceManager, type DeviceManagerEvents } from "../DeviceManager.js";
import type { MobileDevTestOp } from "../dev/host.js";
import type { FetchLike } from "../download.js";
import { FakeDriver } from "../FakeDriver.js";
import { FakeProcessRunner } from "../FakeProcessRunner.js";
import type { HostArch, HostOs } from "../host.js";
import type { MobileService } from "../MobileService.js";

export const FAKE_AVD = "Pixel_Test";
export const FAKE_SERIAL = "emulator-5554";
const SCREEN = { width: 360, height: 800 };

/**
 * The mobile service e2e tests run against: one running Android emulator, Pixel_Test, and no iOS. Nothing here
 * starts a real tool or reaches the network. Only a mock test launch with ZLI_TEST_MOBILE=fake uses it.
 */
export type FakeMobile = {
  readonly service: MobileService;
  /** Give these to the mobile dev host, so feature probes are scripted too. */
  readonly runner: FakeProcessRunner;
  readonly fetch: FetchLike;
  /** runner-answer and fetch-answer, for zli:test:mobile. */
  readonly testOps: Record<string, MobileDevTestOp>;
};

export function createFakeMobileService(options: {
  os: HostOs;
  arch: HostArch;
  events?: DeviceManagerEvents & { setup?: (progress: MobileSetupProgress) => void };
}): FakeMobile {
  const android = new FakeDriver("android", [
    {
      deviceId: `android-avd:${FAKE_AVD}`,
      platform: "android",
      kind: "emulator",
      name: FAKE_AVD,
      state: "online",
      serial: FAKE_SERIAL,
      osVersion: "15",
    },
  ]);
  android.size = SCREEN;
  const still = solidPng(SCREEN.width, SCREEN.height, [32, 36, 44]);
  android.screenshot = async () => ({ data: still, ...SCREEN });
  // Without a connection there is no scrcpy video, so the panel shows the fake's screenshots.
  Object.assign(android, {
    connection: async () => {
      throw new Error("the fake emulator has no adb connection.");
    },
  });
  const manager = new DeviceManager({
    android: android as unknown as AndroidDriver,
    ios: new FakeDriver("ios", []),
    scrcpyServer: async () => {
      throw new Error("The fake mobile service has no scrcpy server.");
    },
    ...(options.events ? { events: options.events } : {}),
  });

  const runnerAnswers: MobileTestRunnerAnswer[] = [];
  const runner = new FakeProcessRunner((command, args) => {
    const line = [command, ...args].join(" ");
    return runnerAnswers.findLast((entry) => line.includes(entry.match))?.answer;
  });
  const fetchAnswers = new Map<string, MobileTestFetchAnswer>();
  const fetch: FetchLike = async (url) => {
    const answer = fetchAnswers.get(url);
    const text = answer ? JSON.stringify(answer.json ?? null) : "Not found";
    const status = answer?.status ?? 404;
    return {
      ok: status >= 200 && status < 300,
      status,
      body: new Blob([text]).stream(),
      headers: { get: (name) => (name.toLowerCase() === "content-type" && answer ? "application/json" : null) },
      text: async () => text,
    };
  };

  const idle: MobileSetupProgress = { state: "idle", message: "" };
  const setup = {
    progress: idle,
    running: false,
    plan: async (): Promise<MobileSetupPlan> => ({
      sdkRoot: "/fake/android-sdk",
      steps: [],
      licenses: [],
      systemImage: "system-images;android-35;google_apis;x86_64",
      avdName: FAKE_AVD,
    }),
    run: async () => undefined,
    cancel: () => undefined,
  };
  const avdList: MobileAvdList = {
    avdmanager: true,
    avds: [{ name: FAKE_AVD, displayName: "Pixel Test", systemImage: "system-images;android-35;google_apis;x86_64" }],
    systemImages: ["system-images;android-35;google_apis;x86_64"],
    deviceProfiles: [{ id: "pixel_7", name: "Pixel 7" }],
    defaultDeviceProfile: "pixel_7",
  };
  const avds = { list: async () => avdList, create: async () => avdList, delete: async () => avdList };
  const found = (path: string, version: string) => ({ found: true, path, version });
  const androidStatus: MobileAndroidStatus = {
    sdkRoot: "/fake/android-sdk",
    sdkSource: "zli",
    adb: found("/fake/android-sdk/platform-tools/adb", "35.0.2"),
    emulator: found("/fake/android-sdk/emulator/emulator", "35.3.11"),
    sdkmanager: found("/fake/android-sdk/cmdline-tools/latest/bin/sdkmanager", "17.0"),
    avdmanager: found("/fake/android-sdk/cmdline-tools/latest/bin/avdmanager", "17.0"),
    java: found("/fake/jdk/bin/java", "17.0.12"),
    systemImages: avdList.systemImages,
    avds: [FAKE_AVD],
    acceleration: { checked: true, usable: true, detail: "The fake emulator needs no acceleration." },
    missing: [],
  };

  const service: MobileService = {
    manager,
    // The panel and the IPC handlers only use these members, so the fakes stand in for the real classes.
    setup: setup as unknown as AndroidSetup,
    environment: {} as AndroidEnvironment,
    avds: avds as unknown as AvdManager,
    // Answers come from runner-answer, like every other command the fake service runs.
    wireless: new AndroidWireless({
      runner,
      tools: async () => ({ adb: androidStatus.adb.path ?? "adb", env: {} }),
      manager,
      sleep: async () => undefined,
    }),
    status: async () => ({
      host: { os: options.os, arch: options.arch },
      android: androidStatus,
      ios: { supported: false, simctl: { found: false }, idb: { found: false }, missing: ["A Mac with Xcode"] },
    }),
    dispose: () => manager.dispose(),
  };

  return {
    service,
    runner,
    fetch,
    testOps: {
      "runner-answer": (input) => {
        runnerAnswers.push(MobileTestRunnerAnswer.parse(input));
        return { accepted: true };
      },
      "fetch-answer": (input) => {
        const answer = MobileTestFetchAnswer.parse(input);
        fetchAnswers.set(answer.url, answer);
        return { accepted: true };
      },
    },
  };
}

/** A PNG of one color, so the fake emulator's screen is a real image. */
function solidPng(width: number, height: number, rgb: readonly [number, number, number]): Buffer {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set(rgb, 1 + x * 3);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
