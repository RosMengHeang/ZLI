import { describe, expect, it } from "vitest";

import { FakeProcessRunner } from "./FakeProcessRunner.js";
import type { MobileFileSystem } from "./host.js";
import { createMobileService } from "./MobileService.js";

const SSH = "C:\\Windows\\System32\\OpenSSH\\ssh.exe";

const SIMCTL = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [
      { udid: "AAAA-1111", name: "iPhone 16", state: "Shutdown", isAvailable: true },
    ],
  },
});

const files = (present: string[]): MobileFileSystem => ({
  exists: async (path) => present.includes(path),
  isDirectory: async () => false,
  readdir: async () => [],
  readFile: async () => {
    throw new Error("no file");
  },
});

function service(host: () => string | undefined) {
  const runner = new FakeProcessRunner((command, args) => {
    if (command !== SSH) return { code: 1, stderr: "not found" };
    const line = args.at(-1) ?? "";
    if (line.includes("/bin/sh -c")) return { stdout: "simctl=yes\nidb=/opt/homebrew/bin/idb\n" };
    if (line.endsWith("simctl list devices --json")) return { stdout: SIMCTL };
    return undefined;
  });
  const mobile = createMobileService({
    os: "windows",
    arch: "x64",
    env: { PATH: "", SystemRoot: "C:\\Windows" },
    home: "C:\\Users\\dev",
    mobileDir: "C:\\Users\\dev\\AppData\\Roaming\\ZLI\\mobile",
    runner,
    fs: files([SSH]),
    iosHost: async () => host(),
  });
  return { mobile, runner };
}

describe("mobile service with a Mac for iPhone simulators", () => {
  it("lists the Mac's simulators on Windows once a Mac is set, and none before", async () => {
    let host: string | undefined;
    const { mobile, runner } = service(() => host);
    expect((await mobile.manager.list()).filter((device) => device.platform === "ios")).toEqual([]);
    expect((await mobile.status()).ios).toMatchObject({ supported: false });
    expect(runner.calls.some((call) => call.command === SSH)).toBe(false);

    host = "dev@studio.local";
    const ios = (await mobile.manager.list()).filter((device) => device.platform === "ios");
    expect(ios).toEqual([
      expect.objectContaining({ deviceId: "ios:AAAA-1111", name: "iPhone 16", host: "dev@studio.local" }),
    ]);
    expect((await mobile.status()).ios).toEqual({
      supported: true,
      host: "dev@studio.local",
      simctl: { found: true, path: "/usr/bin/xcrun" },
      idb: { found: true, path: "/opt/homebrew/bin/idb" },
      missing: [],
    });
    await mobile.dispose();
  });

  it("tests a Mac that is not saved yet", async () => {
    const { mobile } = service(() => undefined);
    expect(await mobile.testIosHost("dev@studio.local")).toEqual({
      ok: true,
      simulators: 1,
      message: "Connected to studio.local. Found 1 simulator.",
    });
    await mobile.dispose();
  });
});
