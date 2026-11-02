import { withoutPrivateEnv } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { sshCommandHost } from "./CommandHost.js";
import { FakeProcessRunner } from "./FakeProcessRunner.js";
import {
  IosSimulatorDriver,
  parseIdbDescribe,
  parseSimctlDevices,
  SIMULATOR_ROTATE_SCRIPT,
  simulatorRotateError,
} from "./IosSimulatorDriver.js";
import type { ProcessRunner, RunOptions } from "./ProcessRunner.js";

/** The environment main.ts gives the mobile service: the app's own, with ZLI's runtime secrets removed. */
const TEST_ENV = withoutPrivateEnv({
  PATH: "/usr/bin",
  ZLI_RUNTIME_TOKEN: "runtime-secret",
  ZLI_DAEMON_TOKEN: "daemon-secret",
});

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

  it("runs every simctl command, the crash log stream too, without ZLI's runtime token", async () => {
    const fake = runner();
    const ios = new IosSimulatorDriver({
      env: TEST_ENV,
      runner: fake,
      tools: async () => ({ xcrun: "/usr/bin/xcrun" }),
    });
    const [iphone] = await ios.list();
    if (!iphone) throw new Error("missing iPhone");
    await ios.streamLogs(iphone);
    expect(fake.spawned.map((process) => process.args.slice(0, 3))).toEqual([["simctl", "spawn", "AAAA-1111"]]);
    expect(fake.calls).toHaveLength(2);
    for (const call of fake.calls) {
      expect(call.options?.env).toEqual({ PATH: "/usr/bin" });
      expect(call.options?.env).not.toHaveProperty("ZLI_RUNTIME_TOKEN");
    }
  });

  it("lists simulators and boots one that is already booted without failing", async () => {
    const fake = runner();
    const ios = new IosSimulatorDriver({
      env: TEST_ENV,
      runner: fake,
      tools: async () => ({ xcrun: "/usr/bin/xcrun" }),
    });
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
    const ios = new IosSimulatorDriver({ env: TEST_ENV, runner, tools: async () => ({ xcrun: "/usr/bin/xcrun" }) });
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
    const ios = new IosSimulatorDriver({
      env: TEST_ENV,
      runner: runner(),
      tools: async () => ({ xcrun: "/usr/bin/xcrun" }),
    });
    const none = new IosSimulatorDriver({ env: TEST_ENV, runner: runner(), tools: async () => ({}) });
    expect(await none.list()).toEqual([]);
    const [iphone] = await ios.list();
    if (!iphone) throw new Error("missing iPhone");
    await expect(ios.tap(iphone, 10, 10, false)).rejects.toThrow(/needs idb/u);
    await expect(ios.rotate(iphone, undefined)).rejects.toThrow("Rotating a simulator needs macOS.");
    await expect(ios.install(iphone, "/tmp/App.ipa")).rejects.toThrow(/\.app bundle/u);
  });

  it("taps through idb with the simulator's udid", async () => {
    const fake = runner();
    const ios = new IosSimulatorDriver({
      env: TEST_ENV,
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
      env: TEST_ENV,
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
  it("rotates through the Simulator app's shortcut with osascript, finding the window by device name", async () => {
    const fake = runner();
    const ios = new IosSimulatorDriver({
      env: TEST_ENV,
      runner: fake,
      tools: async () => ({ xcrun: "/usr/bin/xcrun", osascript: "/usr/bin/osascript" }),
    });
    const [iphone] = await ios.list();
    if (!iphone) throw new Error("missing iPhone");
    expect(await ios.rotate(iphone, undefined)).toBe("landscape");
    expect(await ios.rotate(iphone, "landscape-reverse")).toBe("landscape-reverse");
    expect(await ios.rotate(iphone, "landscape-reverse")).toBe("landscape-reverse");
    expect(await ios.rotate(iphone, "portrait")).toBe("portrait");
    const script = SIMULATOR_ROTATE_SCRIPT.flatMap((line) => ["-e", line]);
    const calls = fake.argsOf("osascript");
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual([...script, "iPhone 15", "124", "1"]);
    expect(calls.map((args) => args.slice(-3))).toEqual([
      ["iPhone 15", "124", "1"],
      ["iPhone 15", "124", "2"],
      ["iPhone 15", "124", "1"],
    ]);
    expect(SIMULATOR_ROTATE_SCRIPT).toContain("key code arrowKey using command down");
  });

  it("turns the other way for a single step back, and starts from portrait again after a boot", async () => {
    const fake = runner();
    const ios = new IosSimulatorDriver({
      env: TEST_ENV,
      runner: fake,
      tools: async () => ({ xcrun: "/usr/bin/xcrun", osascript: "/usr/bin/osascript" }),
    });
    const [iphone] = await ios.list();
    if (!iphone) throw new Error("missing iPhone");
    await ios.rotate(iphone, "landscape-reverse");
    await ios.boot(iphone, {});
    await ios.rotate(iphone, "landscape");
    expect(fake.argsOf("osascript").map((args) => args.slice(-2))).toEqual([
      ["123", "1"],
      ["124", "1"],
    ]);
  });

  it("explains the Accessibility permission when macOS refuses the keystroke", async () => {
    const refusing = new FakeProcessRunner((command, args) => {
      if (args.join(" ") === "simctl list devices --json") return { stdout: SIMCTL };
      if (command.endsWith("osascript"))
        return {
          code: 1,
          stderr: "execution error: System Events got an error: osascript is not allowed assistive access. (-1719)",
        };
      return undefined;
    });
    const ios = new IosSimulatorDriver({
      env: TEST_ENV,
      runner: refusing,
      tools: async () => ({ xcrun: "/usr/bin/xcrun", osascript: "/usr/bin/osascript" }),
    });
    const [iphone] = await ios.list();
    if (!iphone) throw new Error("missing iPhone");
    await expect(ios.rotate(iphone, undefined)).rejects.toThrow(
      "Allow ZLI in System Settings > Privacy & Security > Accessibility to rotate simulators.",
    );
    // A failed rotation does not count, so the next try turns the same way.
    await expect(ios.rotate(iphone, undefined)).rejects.toThrow(/Accessibility/u);
    expect(refusing.argsOf("osascript").map((args) => args.at(-2))).toEqual(["124", "124"]);
  });

  it("maps each osascript failure to what the person can do", () => {
    const message = (stderr: string) => simulatorRotateError(stderr, "iPhone 15").message;
    expect(message("System Events got an error: ZLI is not allowed assistive access. (-25211)")).toMatch(
      /Accessibility to rotate simulators/u,
    );
    expect(message("Not authorized to send Apple events to System Events. (-1743)")).toMatch(
      /Privacy & Security > Automation/u,
    );
    expect(message("execution error: ZLI_NO_SIMULATOR_WINDOW (1001)")).toBe(
      "Open iPhone 15 in the Simulator app, then rotate it again.",
    );
    expect(message("something else")).toBe("The Simulator app did not rotate iPhone 15: something else");
    expect(simulatorRotateError("(-1719)", "iPhone 15").status).toBe(403);
  });

  it("starts idb's H.264 stream for the simulator, and needs idb for it", async () => {
    const fake = runner();
    const withIdb = new IosSimulatorDriver({
      env: TEST_ENV,
      runner: fake,
      tools: async () => ({ xcrun: "/usr/bin/xcrun", idb: "/opt/homebrew/bin/idb" }),
    });
    const [iphone] = await withIdb.list();
    if (!iphone) throw new Error("missing iPhone");
    const session = await withIdb.startVideo(iphone, { onVideo: () => undefined, onClose: () => undefined });
    expect(fake.spawned[0]?.args).toEqual(["video-stream", "--udid", "AAAA-1111", "--format", "h264", "--fps", "30"]);
    await session.close();
    const without = new IosSimulatorDriver({
      env: TEST_ENV,
      runner: runner(),
      tools: async () => ({ xcrun: "/usr/bin/xcrun" }),
    });
    await expect(without.startVideo(iphone, { onVideo: () => undefined, onClose: () => undefined })).rejects.toThrow(
      /needs idb/u,
    );
  });
});

/** The first 24 bytes of a PNG: the signature and an IHDR chunk with the size. */
function pngHeader(width: number, height: number): Buffer {
  const data = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data, 0);
  data.writeUInt32BE(13, 8);
  data.write("IHDR", 12, "ascii");
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

describe("iOS simulators on a Mac over SSH", () => {
  const remote = () => {
    const fake = new FakeProcessRunner((_command, args) => {
      const line = args.at(-1) ?? "";
      if (line.endsWith("simctl list devices --json")) return { stdout: SIMCTL };
      if (line.includes("screenshot")) return { stdout: pngHeader(1179, 2556) };
      return undefined;
    });
    const host = sshCommandHost({ runner: fake, ssh: "C:\\Windows\\System32\\OpenSSH\\ssh.exe", host: "dev@studio" });
    const ios = new IosSimulatorDriver({
      env: TEST_ENV,
      runner: new FakeProcessRunner(() => {
        throw new Error("a remote simulator must not run anything on this computer");
      }),
      tools: async () => ({ xcrun: "/usr/bin/xcrun", idb: "/opt/homebrew/bin/idb", host }),
    });
    const lines = () =>
      fake.calls.map((call) => call.args.at(-1)?.replace("PATH=/opt/homebrew/bin:/usr/local/bin:$PATH ", ""));
    return { fake, ios, lines };
  };

  it("lists the Mac's simulators with the Mac as their host", async () => {
    const { fake, ios } = remote();
    const [iphone] = await ios.list();
    expect(iphone).toEqual({
      deviceId: "ios:AAAA-1111",
      platform: "ios",
      kind: "simulator",
      name: "iPhone 15",
      state: "online",
      osVersion: "iOS 17.5",
      host: "dev@studio",
    });
    expect(fake.calls[0]?.command).toBe("C:\\Windows\\System32\\OpenSSH\\ssh.exe");
    expect(fake.calls[0]?.args.slice(0, 6)).toEqual([
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=5",
      "--",
      "dev@studio",
    ]);
    expect(fake.calls[0]?.options?.env).toEqual({ PATH: "/usr/bin" });
  });

  it("boots, shuts down, opens URLs, and types through ssh with every argument quoted", async () => {
    const { ios, lines } = remote();
    const devices = await ios.list();
    const ipad = devices[1];
    const iphone = devices[0];
    if (!ipad || !iphone) throw new Error("missing devices");
    await ios.boot(ipad, {});
    await ios.shutdown({ ...ipad, state: "online" });
    await ios.openUrl(iphone, "myapp://open?a=1&b=$(reboot)");
    await ios.type(iphone, "it's done; rm -rf ~");
    expect(lines().slice(1)).toEqual([
      "/usr/bin/xcrun simctl boot BBBB-2222",
      "/usr/bin/xcrun simctl bootstatus BBBB-2222 -b",
      "/usr/bin/xcrun simctl shutdown BBBB-2222",
      "/usr/bin/xcrun simctl openurl AAAA-1111 'myapp://open?a=1&b=$(reboot)'",
      `/opt/homebrew/bin/idb ui text --udid AAAA-1111 'it'\\''s done; rm -rf ~'`,
    ]);
  });

  it("takes screenshots from simctl's stdout instead of a file", async () => {
    const { ios, lines } = remote();
    const [iphone] = await ios.list();
    if (!iphone) throw new Error("missing iPhone");
    expect(await ios.screenshot(iphone)).toMatchObject({ width: 1179, height: 2556 });
    expect(lines().at(-1)).toBe("/usr/bin/xcrun simctl io AAAA-1111 screenshot '--type=png' -");
  });

  it("refuses what cannot work from another computer yet, and says why", async () => {
    const { ios } = remote();
    const [iphone] = await ios.list();
    if (!iphone) throw new Error("missing iPhone");
    await expect(ios.install(iphone, "C:\\builds\\App.app")).rejects.toThrow(
      "ZLI cannot copy an app from this computer to a simulator on studio yet.",
    );
    await expect(ios.rotate(iphone, undefined)).rejects.toThrow(
      "ZLI cannot rotate a simulator on studio yet. Rotate it in the Simulator app on the Mac.",
    );
    await expect(ios.startVideo(iphone, { onVideo: () => undefined, onClose: () => undefined })).rejects.toThrow(
      "Live video from a simulator on studio is not supported yet.",
    );
  });

  it("points to Test connection when the Mac's tools are not reachable", async () => {
    const host = sshCommandHost({ runner: new FakeProcessRunner(), ssh: "ssh", host: "dev@studio" });
    const ios = new IosSimulatorDriver({
      env: TEST_ENV,
      runner: new FakeProcessRunner(),
      tools: async () => ({ host }),
    });
    expect(await ios.list()).toEqual([]);
    await expect(
      ios.shutdown({ deviceId: "ios:AAAA", platform: "ios", kind: "simulator", name: "iPhone", state: "online" }),
    ).rejects.toThrow("ZLI cannot run Xcode's simulator tools on studio. Test the connection in Settings > Mobile.");
  });
});
