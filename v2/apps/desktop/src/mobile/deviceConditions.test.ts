import { describe, expect, it } from "vitest";

import { AndroidDriver, type AndroidTools } from "./AndroidDriver.js";
import {
  androidPermissionFailure,
  coordinate,
  parseFontScale,
  parseIosAppearance,
  parseIosContentSize,
  parseNightMode,
  pushPayload,
} from "./deviceConditions.js";
import { FakeProcessRunner, type FakeRunHandler } from "./FakeProcessRunner.js";
import { IosSimulatorDriver } from "./IosSimulatorDriver.js";
import type { DriverDevice } from "./MobileDriver.js";

const androidTools: AndroidTools = { adb: "/sdk/platform-tools/adb", env: { ANDROID_HOME: "/sdk" }, avds: [] };

const emulator: DriverDevice = {
  deviceId: "android-avd:Pixel_7",
  platform: "android",
  kind: "emulator",
  name: "Pixel 7",
  state: "online",
  serial: "emulator-5554",
};
const phone: DriverDevice = {
  deviceId: "android:R5CT",
  platform: "android",
  kind: "physical",
  name: "Galaxy S23",
  state: "online",
  serial: "R5CT",
};
const simulator: DriverDevice = {
  deviceId: "ios:AAAA-1111",
  platform: "ios",
  kind: "simulator",
  name: "iPhone 15",
  state: "online",
};

function android(handler: FakeRunHandler = () => undefined) {
  const runner = new FakeProcessRunner(handler);
  return { runner, driver: new AndroidDriver({ runner, tools: async () => androidTools }) };
}

function ios(handler: FakeRunHandler = () => undefined) {
  const runner = new FakeProcessRunner(handler);
  const driver = new IosSimulatorDriver({
    runner,
    env: { PATH: "/usr/bin" },
    tools: async () => ({ xcrun: "/usr/bin/xcrun" }),
  });
  return { runner, driver };
}

/** The adb shell line of each call, or the adb arguments after the serial for non-shell calls. */
const adbLines = (runner: FakeProcessRunner) =>
  runner.argsOf("adb").map((args) => (args[2] === "shell" ? (args[3] ?? "") : args.slice(2).join(" ")));

describe("device condition output", () => {
  it("reads Android night mode and font scale", () => {
    expect(parseNightMode("Night mode: yes")).toBe("dark");
    expect(parseNightMode("Night mode: no\n")).toBe("light");
    expect(parseNightMode("Night mode: auto")).toBeUndefined();
    expect(parseFontScale("1.15\n")).toBe("large");
    expect(parseFontScale("null")).toBe("default");
    expect(parseFontScale("1.0")).toBe("default");
    expect(parseFontScale("1.1")).toBeUndefined();
    expect(parseFontScale("")).toBeUndefined();
  });

  it("reads simctl appearance and content size", () => {
    expect(parseIosAppearance("dark\n")).toBe("dark");
    expect(parseIosAppearance("unsupported")).toBeUndefined();
    expect(parseIosContentSize("large\n")).toBe("default");
    expect(parseIosContentSize("extra-extra-extra-large")).toBe("largest");
    expect(parseIosContentSize("accessibility-medium")).toBeUndefined();
  });

  it("writes coordinates as plain decimals and the push payload as APNs JSON", () => {
    expect(coordinate(-122.4194)).toBe("-122.4194");
    expect(coordinate(0.0000001)).toBe("0");
    expect(coordinate(12.12345678)).toBe("12.123457");
    expect(JSON.parse(pushPayload({ title: "Order shipped", body: "" }))).toEqual({
      aps: { alert: { title: "Order shipped" }, sound: "default" },
    });
  });

  it("sorts pm failures", () => {
    expect(
      androidPermissionFailure(
        "Exception occurred while executing 'grant':\njava.lang.SecurityException: Package com.x has not requested permission android.permission.CAMERA",
      ),
    ).toBe("not-requested");
    expect(
      androidPermissionFailure(
        "java.lang.IllegalArgumentException: Unknown permission: android.permission.POST_NOTIFICATIONS",
      ),
    ).toBe("unknown-permission");
    expect(androidPermissionFailure("java.lang.IllegalArgumentException: Unknown package: com.x")).toBe(
      "not-installed",
    );
    expect(androidPermissionFailure("Killed")).toBe("other");
  });
});

describe("Android device conditions", () => {
  it("switches night mode and font scale through adb shell, and reads them back", async () => {
    const { runner, driver } = android((_command, args) => {
      const line = args[3] ?? "";
      if (line === "cmd uimode night") return { stdout: "Night mode: yes\n" };
      if (line === "settings get system font_scale") return { stdout: "1.3\n" };
      if (line.startsWith("cmd uimode night"))
        return { stdout: `Night mode: ${line.endsWith("yes") ? "yes" : "no"}\n` };
      return undefined;
    });
    await driver.setAppearance(emulator, "dark");
    await driver.setAppearance(emulator, "light");
    await driver.setTextSize(emulator, "small");
    await driver.setTextSize(emulator, "largest");
    expect(await driver.readConditions(emulator)).toEqual({ appearance: "dark", textSize: "largest" });
    expect(runner.argsOf("adb")[0]?.slice(0, 3)).toEqual(["-s", "emulator-5554", "shell"]);
    expect(adbLines(runner)).toEqual([
      "cmd uimode night yes",
      "cmd uimode night no",
      "settings put system font_scale 0.85",
      "settings put system font_scale 1.3",
      "cmd uimode night",
      "settings get system font_scale",
    ]);
  });

  it("gives the emulator console longitude before latitude, and refuses physical phones", async () => {
    const { runner, driver } = android();
    await driver.setLocation(emulator, { latitude: 37.7749, longitude: -122.4194 });
    expect(runner.argsOf("adb")).toEqual([["-s", "emulator-5554", "emu", "geo", "fix", "-122.4194", "37.7749"]]);
    await expect(driver.setLocation(phone, { latitude: 1, longitude: 2 })).rejects.toMatchObject({
      status: 409,
      message: "ZLI can set the location only on an emulator. Change it on the phone instead.",
    });
    expect(runner.calls).toHaveLength(1);
  });

  it("reports a location the console refused", async () => {
    const { driver } = android(() => ({ stdout: "KO: bad parameters\n" }));
    await expect(driver.setLocation(emulator, { latitude: 1, longitude: 2 })).rejects.toThrow(
      "The emulator did not take the location: KO: bad parameters",
    );
  });

  it("grants and revokes every Android permission behind a kind, skipping ones the app does not declare", async () => {
    const { runner, driver } = android((_command, args) => {
      const line = args[3] ?? "";
      if (line.endsWith("READ_EXTERNAL_STORAGE"))
        return {
          code: 255,
          stderr:
            "java.lang.SecurityException: Package com.example.app has not requested permission android.permission.READ_EXTERNAL_STORAGE",
        };
      return undefined;
    });
    await driver.setPermission(emulator, "com.example.app", "camera", true);
    await driver.setPermission(emulator, "com.example.app", "location", false);
    await driver.setPermission(emulator, "com.example.app", "photos", true);
    await driver.setPermission(emulator, "com.example.app", "notifications", true);
    await driver.setPermission(emulator, "com.example.app", "contacts", true);
    await driver.setPermission(emulator, "com.example.app", "microphone", false);
    expect(adbLines(runner)).toEqual([
      "pm grant com.example.app android.permission.CAMERA",
      "pm revoke com.example.app android.permission.ACCESS_FINE_LOCATION",
      "pm revoke com.example.app android.permission.ACCESS_COARSE_LOCATION",
      "pm grant com.example.app android.permission.READ_MEDIA_IMAGES",
      "pm grant com.example.app android.permission.READ_EXTERNAL_STORAGE",
      "pm grant com.example.app android.permission.POST_NOTIFICATIONS",
      "pm grant com.example.app android.permission.READ_CONTACTS",
      "pm grant com.example.app android.permission.WRITE_CONTACTS",
      "pm revoke com.example.app android.permission.RECORD_AUDIO",
    ]);
  });

  it("explains a permission the app does not declare, a missing app, and an old Android", async () => {
    const answer = (stderr: string) => android(() => ({ code: 255, stderr })).driver;
    await expect(
      answer(
        "java.lang.SecurityException: Package com.example.app has not requested permission android.permission.CAMERA",
      ).setPermission(emulator, "com.example.app", "camera", true),
    ).rejects.toMatchObject({
      status: 409,
      message: "com.example.app does not ask for camera in its manifest, so Android cannot grant it.",
    });
    await expect(
      answer("java.lang.IllegalArgumentException: Unknown package: com.example.app").setPermission(
        emulator,
        "com.example.app",
        "camera",
        true,
      ),
    ).rejects.toMatchObject({ status: 404, message: "com.example.app is not installed on Pixel 7." });
    await expect(
      answer(
        "java.lang.IllegalArgumentException: Unknown permission: android.permission.POST_NOTIFICATIONS",
      ).setPermission(emulator, "com.example.app", "notifications", true),
    ).rejects.toMatchObject({ status: 409, message: "This Android version has no notifications permission to grant." });
    await expect(
      answer(
        "Exception occurred while executing 'revoke':\njava.lang.SecurityException: Permission android.permission.CAMERA is not a changeable permission type\n\tat com.android.server.pm.Foo(Foo.java:1)",
      ).setPermission(emulator, "com.example.app", "camera", false),
    ).rejects.toMatchObject({
      status: 502,
      message:
        "Android did not revoke camera for com.example.app: Permission android.permission.CAMERA is not a changeable permission type",
    });
  });

  it("quotes nothing it does not need to, so no argument reaches the device shell unescaped", async () => {
    const { runner, driver } = android();
    await driver.setPermission(emulator, "com.example.app", "camera", true);
    expect(runner.argsOf("adb")[0]).toEqual([
      "-s",
      "emulator-5554",
      "shell",
      "pm grant com.example.app android.permission.CAMERA",
    ]);
  });
});

describe("iOS simulator conditions", () => {
  it("runs simctl ui, location, privacy, and push for the simulator", async () => {
    const { runner, driver } = ios((_command, args) => {
      if (args.join(" ") === "simctl ui AAAA-1111 appearance") return { stdout: "light\n" };
      if (args.join(" ") === "simctl ui AAAA-1111 content_size") return { stdout: "extra-large\n" };
      return undefined;
    });
    await driver.setAppearance(simulator, "dark");
    await driver.setTextSize(simulator, "large");
    await driver.setLocation(simulator, { latitude: -33.8688, longitude: 151.2093 });
    await driver.clearLocation(simulator);
    await driver.setPermission(simulator, "com.example.app", "photos", true);
    await driver.setPermission(simulator, "com.example.app", "location", false);
    await driver.sendNotification(simulator, "com.example.app", { title: "Order shipped", body: "Arrives Friday" });
    expect(await driver.readConditions(simulator)).toEqual({ appearance: "light", textSize: "large" });
    expect(runner.argsOf("xcrun").map((args) => args.join(" "))).toEqual([
      "simctl ui AAAA-1111 appearance dark",
      "simctl ui AAAA-1111 content_size extra-large",
      "simctl location AAAA-1111 set -33.8688,151.2093",
      "simctl location AAAA-1111 clear",
      "simctl privacy AAAA-1111 grant photos com.example.app",
      "simctl privacy AAAA-1111 revoke location com.example.app",
      "simctl push AAAA-1111 com.example.app -",
      "simctl ui AAAA-1111 appearance",
      "simctl ui AAAA-1111 content_size",
    ]);
    const push = runner.calls.find((call) => call.args[1] === "push");
    expect(JSON.parse(String((push?.options as { input?: string } | undefined)?.input))).toEqual({
      aps: { alert: { title: "Order shipped", body: "Arrives Friday" }, sound: "default" },
    });
  });

  it("refuses the permissions simctl has no service for, before running anything", async () => {
    const { runner, driver } = ios();
    await expect(driver.setPermission(simulator, "com.example.app", "camera", true)).rejects.toMatchObject({
      status: 409,
      message: "The iOS Simulator has no camera, so simctl has no camera permission to set.",
    });
    await expect(driver.setPermission(simulator, "com.example.app", "notifications", true)).rejects.toMatchObject({
      status: 409,
    });
    expect(runner.calls).toEqual([]);
  });

  it("says what simctl reported when a change fails, and refuses a simulator that is off", async () => {
    const { driver } = ios(() => ({ code: 1, stderr: "Invalid device: AAAA-1111" }));
    await expect(driver.setAppearance(simulator, "dark")).rejects.toThrow(
      "xcrun simctl failed: Invalid device: AAAA-1111",
    );
    await expect(driver.setAppearance({ ...simulator, state: "shutdown" }, "dark")).rejects.toMatchObject({
      status: 409,
    });
  });
});
