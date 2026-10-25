import type { MobileDevice } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import {
  accelerationProblem,
  androidNeedsInstall,
  androidSituation,
  errorText,
  formatBytes,
  framePoint,
  keyInput,
  leaseNotice,
  pickDevice,
  planDownload,
  progressPercent,
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
    expect(keyInput("d", { key: "ArrowLeft", ...plain })).toBeUndefined();
  });

  it("says who holds a device", () => {
    expect(leaseNotice({ lease: null })).toBeUndefined();
    expect(
      leaseNotice({
        lease: { ownerId: "agent:1", ownerLabel: "The agent in app", kind: "agent", acquiredAt: "" },
      })?.text,
    ).toBe("The agent in app is using this device. Take over to use it yourself.");
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
});
