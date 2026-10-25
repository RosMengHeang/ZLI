// @vitest-environment node

import type { MobileDevice } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import {
  accelerationProblem,
  androidNeedsInstall,
  androidSituation,
  deviceGroup,
  deviceSummary,
  devicesInGroups,
  errorText,
  expoServer,
  expoUrl,
  formatBytes,
  formatElapsed,
  framePoint,
  isPasteShortcut,
  keyInput,
  leaseNotice,
  logLineCount,
  openedNotice,
  pickDevice,
  planDownload,
  progressPercent,
  screenModeChip,
  screenshotBlob,
  sendTextInput,
  slowBootNote,
  suggestAvdName,
  systemImageLabel,
  textChunks,
  urlToOpen,
  wheelPixels,
  wheelSwipe,
} from "./mobile.js";

const device = (deviceId: string, state: MobileDevice["state"]): MobileDevice => ({
  deviceId,
  platform: "android",
  kind: "emulator",
  name: deviceId,
  state,
  lease: null,
});

describe("mobile panel helpers", () => {
  it("drops Electron's remote method prefix from errors", () => {
    expect(
      errorText(
        new Error("Error invoking remote method 'zli:mobile:boot': MobileDriverError: The emulator stopped."),
        "x",
      ),
    ).toBe("The emulator stopped.");
    expect(errorText(undefined, "Could not boot.")).toBe("Could not boot.");
  });

  it("maps pointer positions to frame pixels and ignores points outside the screen", () => {
    const rect = { left: 100, top: 50, width: 360, height: 800 };
    const frame = { width: 720, height: 1600 };
    expect(framePoint({ x: 280, y: 450 }, rect, frame)).toEqual({ x: 360, y: 800 });
    expect(framePoint({ x: 460, y: 850 }, rect, frame)).toEqual({ x: 719, y: 1599 });
    expect(framePoint({ x: 99, y: 450 }, rect, frame)).toBeUndefined();
    expect(framePoint({ x: 280, y: 450 }, rect, { width: 0, height: 0 })).toBeUndefined();
  });

  it("turns keys into typing and buttons, leaving shortcuts alone", () => {
    const plain = { ctrlKey: false, metaKey: false, altKey: false };
    expect(keyInput("d", { key: "a", ...plain })).toEqual({ deviceId: "d", type: "text", text: "a" });
    expect(keyInput("d", { key: "Backspace", ...plain })).toEqual({ deviceId: "d", type: "button", button: "delete" });
    expect(keyInput("d", { key: "a", ...plain, metaKey: true })).toBeUndefined();
    expect(keyInput("d", { key: "F5", ...plain })).toBeUndefined();
  });

  it("sends arrows and Tab as device buttons, and lets Shift+Tab leave the screen", () => {
    const plain = { ctrlKey: false, metaKey: false, altKey: false };
    const buttons = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab"].map((key) => {
      const input = keyInput("d", { key, ...plain });
      return input?.type === "button" ? input.button : undefined;
    });
    expect(buttons).toEqual(["dpad_up", "dpad_down", "dpad_left", "dpad_right", "tab"]);
    expect(keyInput("d", { key: "Tab", ...plain, shiftKey: true })).toBeUndefined();
    expect(keyInput("d", { key: "ArrowUp", ...plain, ctrlKey: true })).toBeUndefined();
  });

  it("turns a wheel burst into a swipe that moves content the way the wheel scrolls", () => {
    const frame = { width: 1080, height: 2400 };
    expect(wheelSwipe({ x: 0, y: 300 }, { x: 540, y: 1200 }, frame)).toEqual([
      { action: "down", x: 540, y: 1200 },
      { action: "move", x: 540, y: 1125 },
      { action: "move", x: 540, y: 1050 },
      { action: "move", x: 540, y: 975 },
      { action: "move", x: 540, y: 900 },
      { action: "up", x: 540, y: 900 },
    ]);
    const up = wheelSwipe({ x: 0, y: -300 }, { x: 540, y: 1200 }, frame, 1);
    expect(up.at(-1)).toEqual({ action: "up", x: 540, y: 1500 });
    const sideways = wheelSwipe({ x: 100, y: 0 }, { x: 540, y: 1200 }, frame, 1);
    expect(sideways.at(-1)).toEqual({ action: "up", x: 440, y: 1200 });
  });

  it("caps a wheel swipe at 40% of the frame and keeps it on the screen", () => {
    const frame = { width: 1080, height: 2400 };
    expect(wheelSwipe({ x: 0, y: 10_000 }, { x: 540, y: 1200 }, frame, 1).at(-1)).toEqual({
      action: "up",
      x: 540,
      y: 240,
    });
    expect(wheelSwipe({ x: 0, y: 500 }, { x: 540, y: 100 }, frame, 1)).toEqual([
      { action: "down", x: 540, y: 500 },
      { action: "move", x: 540, y: 0 },
      { action: "up", x: 540, y: 0 },
    ]);
    expect(wheelSwipe({ x: 0, y: -500 }, { x: 540, y: 2390 }, frame, 1)[0]).toEqual({
      action: "down",
      x: 540,
      y: 1899,
    });
    expect(wheelSwipe({ x: 0.2, y: -0.3 }, { x: 540, y: 1200 }, frame)).toEqual([]);
  });

  it("reads wheel deltas in pixels, lines, or pages", () => {
    const page = { width: 300, height: 600 };
    expect(wheelPixels({ deltaX: 0, deltaY: 120, deltaMode: 0 }, page)).toEqual({ x: 0, y: 120 });
    expect(wheelPixels({ deltaX: 1, deltaY: 3, deltaMode: 1 }, page)).toEqual({ x: 40, y: 120 });
    expect(wheelPixels({ deltaX: 0, deltaY: 1, deltaMode: 2 }, page)).toEqual({ x: 0, y: 600 });
  });

  it("splits long text into 300-character inputs without breaking a character", async () => {
    const long = "x".repeat(650);
    expect(textChunks(long).map((chunk) => chunk.length)).toEqual([300, 300, 50]);
    expect(textChunks(long).join("")).toBe(long);
    expect(textChunks(`${"a".repeat(299)}\u{1F600}b`)).toEqual(["a".repeat(299), "\u{1F600}b"]);
    expect(textChunks("")).toEqual([]);

    const sent: string[] = [];
    await sendTextInput(
      {
        input: async (input) => {
          if (input.type === "text") sent.push(input.text);
        },
      },
      "d",
      long,
    );
    expect(sent.map((chunk) => chunk.length)).toEqual([300, 300, 50]);
  });

  it("recognizes the paste shortcut with Ctrl or Cmd", () => {
    const plain = { ctrlKey: false, metaKey: false, altKey: false };
    expect(isPasteShortcut({ key: "v", ...plain, ctrlKey: true })).toBe(true);
    expect(isPasteShortcut({ key: "V", ...plain, metaKey: true })).toBe(true);
    expect(isPasteShortcut({ key: "v", ...plain })).toBe(false);
    expect(isPasteShortcut({ key: "v", ...plain, ctrlKey: true, altKey: true })).toBe(false);
  });

  it("says who holds a device", () => {
    expect(leaseNotice({ lease: null })).toBeUndefined();
    expect(
      leaseNotice({
        lease: { ownerId: "agent:1", ownerLabel: "The agent in app", kind: "agent", acquiredAt: "" },
      })?.text,
    ).toBe("The agent in app is using this device. Take over to use it yourself.");
  });

  it("says when an agent's lease ends, and counts down its last two minutes", () => {
    const now = Date.parse("2025-01-01T14:27:00.000Z");
    const held = (expiresAt: string) => ({
      lease: { ownerId: "agent:1", ownerLabel: "Claude", kind: "agent" as const, acquiredAt: "", expiresAt },
    });
    const clock = { now, locale: "en-GB", timeZone: "UTC" };
    expect(leaseNotice(held("2025-01-01T14:32:00.000Z"), clock)?.text).toBe(
      "Claude is using this device until 14:32. Take over to use it yourself.",
    );
    expect(leaseNotice(held("2025-01-01T14:32:00.000Z"), { ...clock, locale: "en-US" })?.text).toContain(
      "until 2:32 PM.",
    );
    expect(leaseNotice(held("2025-01-01T14:28:40.000Z"), clock)?.text).toBe(
      "Claude is using this device for about 2 more minutes. Take over to use it yourself.",
    );
    expect(leaseNotice(held("2025-01-01T14:28:10.000Z"), clock)?.text).toContain("for about 1 more minute.");
    expect(leaseNotice(held("2025-01-01T14:27:20.000Z"), clock)?.text).toContain("for less than a minute more.");
    expect(
      leaseNotice({ lease: { ownerId: "person", ownerLabel: "You", kind: "person", acquiredAt: "" } }, clock)?.text,
    ).toBe("You have control. Agents cannot use this device until you hand it back.");
  });

  it("keeps the remembered device, else prefers a running one", () => {
    const devices = [device("a", "shutdown"), device("b", "online")];
    expect(pickDevice(devices, "a")?.deviceId).toBe("a");
    expect(pickDevice(devices, "gone")?.deviceId).toBe("b");
    expect(pickDevice([], undefined)).toBeUndefined();
  });

  it("formats download sizes", () => {
    expect(formatBytes(181_052_239)).toBe("173 MB");
    expect(formatBytes(1_610_612_736)).toBe("1.5 GB");
  });

  it("reads setup state: what to install, acceleration, progress, and download size", () => {
    const found = { found: true };
    const android = {
      sdkSource: "env" as const,
      adb: found,
      emulator: found,
      sdkmanager: found,
      avdmanager: found,
      java: found,
      systemImages: [],
      avds: ["Pixel"],
      acceleration: { checked: true, usable: true, detail: "" },
      missing: [],
    };
    expect(androidNeedsInstall(android)).toBe(false);
    expect(androidNeedsInstall({ ...android, avds: [] })).toBe(true);
    expect(androidNeedsInstall({ ...android, emulator: { found: false } })).toBe(true);
    expect(androidSituation(android)).toBe("ready");
    expect(androidSituation({ ...android, avds: [] })).toBe("create");
    expect(androidSituation({ ...android, adb: { found: false }, avds: [] })).toBe("install");
    expect(accelerationProblem(android)).toBeUndefined();
    expect(
      accelerationProblem({ ...android, acceleration: { checked: false, usable: false, detail: "" } }),
    ).toBeUndefined();
    expect(accelerationProblem({ ...android, acceleration: { checked: true, usable: false, detail: "" } })).toMatch(
      /hardware acceleration/u,
    );

    expect(progressPercent({ state: "running", message: "", percent: 40 })).toBe(40);
    expect(progressPercent({ state: "running", message: "", receivedBytes: 1, totalBytes: 4 })).toBe(25);
    expect(progressPercent({ state: "running", message: "" })).toBeUndefined();

    expect(
      planDownload({
        steps: [
          { id: "a", label: "A", bytes: 10 },
          { id: "b", label: "B" },
        ],
      }),
    ).toEqual({
      bytes: 10,
      partial: true,
    });
  });

  it("formats a boot's elapsed time as minutes and seconds", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(42_400)).toBe("0:42");
    expect(formatElapsed(65_000)).toBe("1:05");
    expect(formatElapsed(12 * 60_000 + 5_000)).toBe("12:05");
    expect(formatElapsed(-1)).toBe("0:00");
  });

  it("points a slow Android boot at acceleration and a slow iOS boot at Simulator", () => {
    expect(slowBootNote({ platform: "android" })).toContain("hardware acceleration");
    expect(slowBootNote({ platform: "ios" })).toContain("Simulator app");
  });

  it("labels live video and screenshots, with the reason as the tooltip", () => {
    expect(screenModeChip({ live: true, reason: undefined })).toEqual({
      label: "Live",
      tone: "success",
      title: undefined,
    });
    expect(screenModeChip({ live: false, reason: "No decoder." })).toEqual({
      label: "Screenshots",
      tone: "quiet",
      title: "About 1 per second. No decoder.",
    });
    expect(screenModeChip({ live: false, reason: undefined })).toEqual({
      label: "Screenshots",
      tone: "quiet",
      title: "About 1 per second.",
    });
  });

  it("opens a typed address as http when it has no scheme, and keeps schemes it has", () => {
    expect(urlToOpen("  localhost:3000 ")).toBe("http://localhost:3000");
    expect(urlToOpen("example.com/a?b=1")).toBe("http://example.com/a?b=1");
    expect(urlToOpen("https://example.com")).toBe("https://example.com");
    expect(urlToOpen("exp://localhost:8081")).toBe("exp://localhost:8081");
    expect(urlToOpen("mailto:me@example.com")).toBe("mailto:me@example.com");
    expect(urlToOpen("tel:+15551234")).toBe("tel:+15551234");
    expect(urlToOpen("   ")).toBeUndefined();
  });

  it("names the opened URL and the port it forwarded", () => {
    expect(openedNotice("https://example.com", {})).toBe("Opened https://example.com.");
    expect(openedNotice("http://localhost:3000", { reversedPort: 3000 })).toBe(
      "Opened http://localhost:3000. Forwarded localhost:3000 to the device.",
    );
  });
  it("finds the Expo server by port or terminal name, newest first", () => {
    const vite = { port: 5173, url: "http://localhost:5173/" };
    const metro = { port: 8081, url: "http://localhost:8081/" };
    const legacy = { port: 19000, url: "http://localhost:19000/" };
    const web = { port: 19006, url: "http://localhost:19006/" };
    const named = { port: 4000, url: "http://localhost:4000/", name: "npx expo start" };
    expect(expoServer([])).toBeUndefined();
    expect(expoServer([vite])).toBeUndefined();
    expect(expoServer([vite, metro])).toBe(metro);
    expect(expoServer([legacy, metro])).toBe(legacy);
    expect(expoServer([web, metro])).toBe(metro);
    expect(expoServer([vite, web])).toBe(web);
    expect(expoServer([vite, named])).toBe(named);
    expect(expoServer([{ ...vite, name: "Metro bundler" }])?.port).toBe(5173);
    expect(expoUrl(metro)).toBe("exp://localhost:8081");
  });
  it("labels system images and suggests a free name for a new virtual device", () => {
    expect(systemImageLabel("system-images;android-35;google_apis;x86_64")).toBe("API 35, Google APIs, x86_64");
    expect(systemImageLabel("system-images;android-34;google_apis_playstore;arm64-v8a")).toBe(
      "API 34, Google Play, arm64-v8a",
    );
    expect(systemImageLabel("system-images;android-Baklava;custom_tag;x86_64")).toBe("Baklava, custom tag, x86_64");
    const image = "system-images;android-35;google_apis;x86_64";
    expect(suggestAvdName("Pixel 7", image, [])).toBe("Pixel_7_API_35");
    expect(suggestAvdName("Pixel 7", image, ["pixel_7_api_35", "Pixel_7_API_35_2"])).toBe("Pixel_7_API_35_3");
    expect(suggestAvdName("Pixel 9 Pro", undefined, [])).toBe("Pixel_9_Pro");
    expect(suggestAvdName("", undefined, [])).toBe("Device");
  });
  it("reads 200 log lines unless told a number from 1 to 2,000", () => {
    expect(logLineCount("")).toBe(200);
    expect(logLineCount("many")).toBe(200);
    expect(logLineCount("50")).toBe(50);
    expect(logLineCount("0")).toBe(1);
    expect(logLineCount("99999")).toBe(2_000);
  });

  it("groups devices as emulators, phones, then simulators, and sums up each one", () => {
    const phone = { ...device("android:R5CT", "online"), kind: "physical" as const };
    const simulator = { ...device("ios:UDID", "shutdown"), platform: "ios" as const, kind: "simulator" as const };
    const emulator = device("android-avd:Pixel_8", "booting");
    expect(devicesInGroups([simulator, phone, emulator]).map(({ deviceId }) => deviceId)).toEqual([
      "android-avd:Pixel_8",
      "android:R5CT",
      "ios:UDID",
    ]);
    expect([emulator, phone, simulator].map(deviceGroup)).toEqual(["Emulators", "Phones", "Simulators"]);
    expect(deviceSummary({ platform: "android", osVersion: "15", state: "online" })).toBe("Android 15, running");
    expect(deviceSummary({ platform: "ios", state: "shutdown" })).toBe("iOS, off");
  });

  it("maps a pointer at 100% zoom through a screen scrolled partly out of view", () => {
    const rect = { left: -100, top: -400, width: 1080, height: 2400 };
    expect(framePoint({ x: 440, y: 800 }, rect, { width: 1080, height: 2400 })).toEqual({ x: 540, y: 1200 });
    expect(framePoint({ x: -100, y: -400 }, rect, { width: 1080, height: 2400 })).toEqual({ x: 0, y: 0 });
    expect(framePoint({ x: -101, y: 0 }, rect, { width: 1080, height: 2400 })).toBeUndefined();
  });

  it("turns a base64 screenshot into image bytes", async () => {
    const blob = screenshotBlob({ data: btoa("\u0089PNG"), mimeType: "image/png" });
    expect(blob.type).toBe("image/png");
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});
