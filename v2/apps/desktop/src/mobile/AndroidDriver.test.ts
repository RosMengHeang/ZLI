import { describe, expect, it } from "vitest";

import { AndroidDriver, type AndroidTools } from "./AndroidDriver.js";
import { FakeProcessRunner, type FakeRunHandler } from "./FakeProcessRunner.js";
import type { DriverDevice } from "./MobileDriver.js";

const tools: AndroidTools = {
  adb: "/sdk/platform-tools/adb",
  emulator: "/sdk/emulator/emulator",
  env: { ANDROID_HOME: "/sdk" },
  avds: [
    { name: "Pixel_7", displayName: "Pixel 7" },
    { name: "Tablet", displayName: "Tablet" },
  ],
};

function driver(handler: FakeRunHandler) {
  const runner = new FakeProcessRunner(handler);
  let now = 0;
  const android = new AndroidDriver({
    runner,
    tools: async () => tools,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
    now: () => now,
    bootTimeoutMs: 60_000,
  });
  return { runner, android };
}

const shellOf = (args: readonly string[]) => (args[2] === "shell" ? (args[3] ?? "") : undefined);

const online: DriverDevice = {
  deviceId: "android-avd:Pixel_7",
  platform: "android",
  kind: "emulator",
  name: "Pixel 7",
  state: "online",
  serial: "emulator-5554",
};

describe("Android driver", () => {
  it("lists running emulators by AVD, physical phones by serial, and AVDs that are off", async () => {
    const { android } = driver((_command, args) => {
      if (args[0] === "devices")
        return {
          stdout:
            "List of devices attached\nemulator-5554 device product:sdk model:sdk_gphone64 transport_id:1\nR58M unauthorized usb:1-1\n",
        };
      if (args.join(" ") === "-s emulator-5554 emu avd name") return { stdout: "Pixel_7\r\nOK\r\n" };
      return undefined;
    });
    expect(await android.list()).toEqual([
      {
        deviceId: "android-avd:Pixel_7",
        platform: "android",
        kind: "emulator",
        name: "Pixel 7",
        state: "online",
        serial: "emulator-5554",
      },
      {
        deviceId: "android:R58M",
        platform: "android",
        kind: "physical",
        name: "R58M",
        state: "unauthorized",
        serial: "R58M",
      },
      { deviceId: "android-avd:Tablet", platform: "android", kind: "emulator", name: "Tablet", state: "shutdown" },
    ]);
  });

  it("boots an AVD on a free port and waits for sys.boot_completed", async () => {
    let polls = 0;
    const { android, runner } = driver((_command, args) => {
      if (args[0] === "devices") return { stdout: "List of devices attached\nemulator-5554 device\n" };
      if (args.join(" ") === "-s emulator-5554 emu avd name") return { stdout: "Pixel_7\r\nOK\r\n" };
      if (args.join(" ") === "-s emulator-5556 shell getprop sys.boot_completed") {
        polls += 1;
        return polls < 3 ? { code: 1, stderr: "device offline" } : { stdout: "1\n" };
      }
      return undefined;
    });
    const booted = await android.boot(
      { deviceId: "android-avd:Tablet", platform: "android", kind: "emulator", name: "Tablet", state: "shutdown" },
      {},
    );
    expect(booted).toMatchObject({ state: "online", serial: "emulator-5556" });
    expect(runner.spawned[0]?.command).toBe("/sdk/emulator/emulator");
    expect(runner.spawned[0]?.args.slice(0, 4)).toEqual(["-avd", "Tablet", "-port", "5556"]);
    expect(polls).toBe(3);
  });

  it("reports why an emulator stopped while booting", async () => {
    const runner = new FakeProcessRunner(
      (_command, args) => (args[0] === "devices" ? { stdout: "List of devices attached\n" } : { code: 1 }),
      (process) => {
        queueMicrotask(() => {
          process.emit("ERROR | x86_64 emulation currently requires hardware acceleration!\n", "stderr");
          process.exit(1);
        });
      },
    );
    const android = new AndroidDriver({ runner, tools: async () => tools, sleep: async () => undefined, now: () => 0 });
    await expect(
      android.boot(
        { deviceId: "android-avd:Pixel_7", platform: "android", kind: "emulator", name: "Pixel 7", state: "shutdown" },
        {},
      ),
    ).rejects.toThrow(/requires hardware acceleration/u);
  });

  it("reverses localhost ports before opening a dev server URL", async () => {
    const { android, runner } = driver(() => ({ stdout: "Status: ok\n" }));
    expect(await android.openUrl(online, "http://localhost:8081/?platform=android")).toEqual({ reversedPort: 8081 });
    expect(runner.argsOf("adb")).toEqual([
      ["-s", "emulator-5554", "reverse", "tcp:8081", "tcp:8081"],
      [
        "-s",
        "emulator-5554",
        "shell",
        "am start -W -a android.intent.action.VIEW -d 'http://localhost:8081/?platform=android'",
      ],
    ]);
  });

  it("launches by package through the launcher and reports a missing app", async () => {
    const { android } = driver((_command, args) =>
      shellOf(args)?.startsWith("monkey") ? { stdout: "** No activities found to run, monkey aborted.\n" } : undefined,
    );
    await expect(android.launch(online, "com.missing.app", {})).rejects.toThrow(/not installed/u);
  });

  it("types, taps, swipes, presses, and rotates through adb shell input", async () => {
    const { android, runner } = driver((_command, args) =>
      shellOf(args) === "settings get system user_rotation" ? { stdout: "0\n" } : undefined,
    );
    await android.type(online, "hi there");
    await android.tap(online, 10.4, 20.6, false);
    await android.tap(online, 5, 5, true);
    await android.swipe(online, { x: 1, y: 2 }, { x: 3, y: 4 }, 300);
    await android.press(online, "back");
    expect(await android.rotate(online, undefined)).toBe("landscape");
    expect(runner.argsOf("adb").map(shellOf)).toEqual([
      "input text hi%sthere",
      "input tap 10 21",
      "input swipe 5 5 5 5 800",
      "input swipe 1 2 3 4 300",
      "input keyevent 4",
      "settings get system user_rotation",
      "settings put system accelerometer_rotation 0",
      "settings put system user_rotation 1",
    ]);
  });

  it("dumps the UI tree, retrying while the screen animates", async () => {
    let attempts = 0;
    const { android } = driver((_command, args) => {
      const shell = shellOf(args);
      if (shell?.startsWith("uiautomator")) {
        attempts += 1;
        return attempts === 1
          ? { stdout: "ERROR: could not get idle state.\n" }
          : { stdout: "UI hierchary dumped to: /data/local/tmp/zli-window.xml\n" };
      }
      if (args[2] === "exec-out")
        return {
          stdout:
            '<hierarchy><node text="OK" class="android.widget.Button" clickable="true" bounds="[0,0][100,50]" /></hierarchy>',
        };
      return undefined;
    });
    const tree = await android.snapshot(online);
    expect(tree.nodes).toEqual([
      { ref: "e1", role: "button", text: "OK", clickable: true, bounds: { x: 0, y: 0, width: 100, height: 50 } },
    ]);
    expect(attempts).toBe(2);
  });

  it("refuses to act on a device that is not running", async () => {
    const { android } = driver(() => undefined);
    await expect(android.tap({ ...online, state: "shutdown" }, 1, 1, false)).rejects.toThrow(/not running/u);
  });

  it("filters logs to an app's process", async () => {
    const { android, runner } = driver((_command, args) => {
      if (shellOf(args) === "pidof -s com.example") return { stdout: "1234\n" };
      if (args[2] === "logcat") return { stdout: "line one\nE crash here\n" };
      return undefined;
    });
    expect(await android.logs(online, { appId: "com.example", lines: 10, filter: "crash" })).toEqual(["E crash here"]);
    expect(runner.argsOf("adb").at(-1)).toContain("--pid=1234");
  });
});
