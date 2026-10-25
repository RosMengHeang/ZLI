import { describe, expect, it } from "vitest";

import { FakeProcessRunner } from "./FakeProcessRunner.js";
import type { ProcessRunner, RunOptions } from "./ProcessRunner.js";
import { IosSimulatorDriver, parseIdbDescribe, parseSimctlDevices } from "./IosSimulatorDriver.js";

const SIMCTL = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [
      { udid: "AAAA-1111", name: "iPhone 15", state: "Booted", isAvailable: true },
      { udid: "BBBB-2222", name: "iPad Air", state: "Shutdown", isAvailable: true },
      { udid: "CCCC-3333", name: "Old", state: "Shutdown", isAvailable: false },
    ],
    "com.apple.CoreSimulator.SimRuntime.watchOS-10-5": [
      { udid: "DDDD-4444", name: "Apple Watch", state: "Shutdown", isAvailable: true },
    ],
    "com.apple.CoreSimulator.SimRuntime.iOS-18-0-1": [{ udid: "EEEE", name: "iPhone 16", state: "Booting" }],
  },
});

describe("simctl output", () => {
  it("keeps available iOS devices with their OS version", () => {
    expect(parseSimctlDevices(SIMCTL).map((device) => [device.udid, device.osVersion, device.state])).toEqual([
      ["AAAA-1111", "iOS 17.5", "Booted"],
      ["BBBB-2222", "iOS 17.5", "Shutdown"],
      ["EEEE", "iOS 18.0.1", "Booting"],
    ]);
  });
});

describe("idb accessibility tree", () => {
  it("turns elements into refs with point frames", () => {
    const tree = parseIdbDescribe(
      JSON.stringify([
        { type: "Application", AXLabel: null, frame: { x: 0, y: 0, width: 393, height: 852 } },
        { type: "StaticText", AXLabel: "Welcome", AXValue: null, frame: { x: 20, y: 100, width: 200, height: 30 } },
        {
          type: "Button",
          AXLabel: "Continue",
          AXUniqueId: "continue",
          frame: { x: 20, y: 700, width: 353, height: 50 },
        },
        {
          type: "TextField",
          AXLabel: "Email",
          AXValue: "a@b.c",
          enabled: true,
          frame: { x: 20, y: 200, width: 353, height: 44 },
        },
        { type: "Other", AXLabel: "hidden", frame: { x: 0, y: 0, width: 0, height: 0 } },
      ]),
    );
    expect(tree.nodes).toEqual([
      { ref: "e1", role: "text", text: "Welcome", bounds: { x: 20, y: 100, width: 200, height: 30 } },
      {
        ref: "e2",
        role: "button",
        label: "Continue",
        id: "continue",
        clickable: true,
        bounds: { x: 20, y: 700, width: 353, height: 50 },
      },
      {
        ref: "e3",
        role: "textfield",
        text: "a@b.c",
        label: "Email",
        clickable: true,
        bounds: { x: 20, y: 200, width: 353, height: 44 },
      },
    ]);
  });
});

describe("iOS simulator driver", () => {
  const runner = () =>
    new FakeProcessRunner((_command, args) => {
      if (args.join(" ") === "simctl list devices --json") return { stdout: SIMCTL };
      if (args[1] === "boot") return { code: 149, stderr: "Unable to boot device in current state: Booted" };
      return undefined;
    });

  it("lists simulators and boots one that is already booted without failing", async () => {
    const fake = runner();
    const ios = new IosSimulatorDriver({ runner: fake, tools: async () => ({ xcrun: "/usr/bin/xcrun" }) });
    const devices = await ios.list();
    expect(devices[0]).toEqual({
      deviceId: "ios:AAAA-1111",
      platform: "ios",
      kind: "simulator",
      name: "iPhone 15",
      state: "online",
      osVersion: "iOS 17.5",
    });
    const ipad = devices[1];
    if (!ipad) throw new Error("missing iPad");
    expect(await ios.boot(ipad, {})).toMatchObject({ state: "online" });
    expect(fake.argsOf("xcrun").slice(1)).toEqual([
      ["simctl", "boot", "BBBB-2222"],
      ["simctl", "bootstatus", "BBBB-2222", "-b"],
    ]);
  });

  it("stops waiting for a boot when the simulator is shut down while it boots", async () => {
    const calls: { args: readonly string[]; options: RunOptions | undefined }[] = [];
    const ok = { code: 0, stdout: Buffer.from(""), stderr: "", timedOut: false };
    const runner: ProcessRunner = {
      run: async (_command, args, options) => {
        calls.push({ args, options });
        if (args[1] !== "bootstatus") return ok;
        // bootstatus waits for the boot; the runner kills it when its signal aborts.
        return new Promise((resolve) =>
          options?.signal?.addEventListener("abort", () => resolve({ ...ok, code: null }), { once: true }),
        );
      },
      spawn: () => {
        throw new Error("not used");
      },
    };
    const ios = new IosSimulatorDriver({ runner, tools: async () => ({ xcrun: "/usr/bin/xcrun" }) });
    const ipad = {
      deviceId: "ios:BBBB-2222",
      platform: "ios",
      kind: "simulator",
      name: "iPad Air",
      state: "shutdown",
    } as const;
    const outcome = ios.boot(ipad, {}).catch((cause: unknown) => cause);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await ios.shutdown({ ...ipad, state: "booting" });
    expect(String(await outcome)).toMatch(/iPad Air was shut down while booting/u);
    expect(calls.map((call) => call.args.join(" "))).toEqual([
      "simctl boot BBBB-2222",
      "simctl bootstatus BBBB-2222 -b",
      "simctl shutdown BBBB-2222",
    ]);
  });

  it("returns nothing on hosts without Xcode, and explains what needs idb", async () => {
    const ios = new IosSimulatorDriver({ runner: runner(), tools: async () => ({ xcrun: "/usr/bin/xcrun" }) });
    const none = new IosSimulatorDriver({ runner: runner(), tools: async () => ({}) });
    expect(await none.list()).toEqual([]);
    const [iphone] = await ios.list();
    if (!iphone) throw new Error("missing iPhone");
    await expect(ios.tap(iphone, 10, 10, false)).rejects.toThrow(/needs idb/u);
    await expect(ios.rotate(iphone, undefined)).rejects.toThrow(/cannot rotate/u);
    await expect(ios.install(iphone, "/tmp/App.ipa")).rejects.toThrow(/\.app bundle/u);
  });

  it("taps through idb with the simulator's udid", async () => {
    const fake = runner();
    const ios = new IosSimulatorDriver({
      runner: fake,
      tools: async () => ({ xcrun: "/usr/bin/xcrun", idb: "/opt/homebrew/bin/idb" }),
    });
    const [iphone] = await ios.list();
    if (!iphone) throw new Error("missing iPhone");
    await ios.tap(iphone, 100.4, 200.6, false);
    await ios.press(iphone, "home");
    expect(fake.argsOf("idb")).toEqual([
      ["ui", "tap", "--udid", "AAAA-1111", "100", "201"],
      ["ui", "button", "--udid", "AAAA-1111", "HOME"],
    ]);
  });

  it("presses arrows and Tab as idb key events, and refuses buttons iOS does not have", async () => {
    const fake = runner();
    const ios = new IosSimulatorDriver({
      runner: fake,
      tools: async () => ({ xcrun: "/usr/bin/xcrun", idb: "/opt/homebrew/bin/idb" }),
    });
    const [iphone] = await ios.list();
    if (!iphone) throw new Error("missing iPhone");
    for (const button of ["dpad_up", "dpad_down", "dpad_left", "dpad_right", "tab"] as const)
      await ios.press(iphone, button);
    expect(fake.argsOf("idb").map((args) => args.at(-1))).toEqual(["82", "81", "80", "79", "43"]);
    await expect(ios.press(iphone, "recents")).rejects.toThrow(/iOS has no recents button/u);
  });
});
