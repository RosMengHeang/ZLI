import { describe, expect, it } from "vitest";
import { emulatorBootArgs } from "./AndroidDriver.js";
import {
  deviceShellCommand,
  deviceShellQuote,
  emulatorPort,
  filterLogLines,
  freeEmulatorPort,
  inputTextArgument,
  localhostPort,
  parseAdbDevices,
  parseEmuAvdName,
  parseWmSize,
  pngSize,
  repairScreencap,
} from "./adb.js";

describe("adb output", () => {
  it("parses adb devices -l", () => {
    const devices = parseAdbDevices(
      [
        "* daemon not running; starting now at tcp:5037",
        "* daemon started successfully",
        "List of devices attached",
        "emulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:1",
        "R58M123ABC             unauthorized usb:1-1 transport_id:2",
        "0a1b2c3d               offline transport_id:3",
        "",
      ].join("\r\n"),
    );
    expect(devices).toEqual([
      {
        serial: "emulator-5554",
        state: "online",
        rawState: "device",
        model: "sdk gphone64 x86 64",
        product: "sdk_gphone64_x86_64",
        emulator: true,
      },
      { serial: "R58M123ABC", state: "unauthorized", rawState: "unauthorized", emulator: false },
      { serial: "0a1b2c3d", state: "offline", rawState: "offline", emulator: false },
    ]);
  });

  it("finds emulator ports and the next free one", () => {
    expect(emulatorPort("emulator-5556")).toBe(5556);
    expect(emulatorPort("R58M123ABC")).toBeUndefined();
    expect(freeEmulatorPort([])).toBe(5554);
    expect(freeEmulatorPort(["emulator-5554", "emulator-5556", "R58M"])).toBe(5558);
  });

  it("reads the AVD name answer", () => {
    expect(parseEmuAvdName("Pixel_7_API_35\r\nOK\r\n")).toBe("Pixel_7_API_35");
    expect(parseEmuAvdName("KO: unknown command\r\n")).toBeUndefined();
  });

  it("reads wm size, preferring the override", () => {
    expect(parseWmSize("Physical size: 1080x2400\n")).toEqual({ width: 1080, height: 2400 });
    expect(parseWmSize("Physical size: 1080x2400\nOverride size: 720x1600\n")).toEqual({ width: 720, height: 1600 });
    expect(parseWmSize("garbage")).toBeUndefined();
  });

  it("reads PNG sizes and repairs CRLF-mangled screencaps", () => {
    const png = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(13, 8);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(1080, 16);
    png.writeUInt32BE(2400, 20);
    expect(pngSize(png)).toEqual({ width: 1080, height: 2400 });
    const mangled = Buffer.from(png.toString("latin1").replaceAll("\n", "\r\n"), "latin1");
    expect(pngSize(repairScreencap(mangled))).toEqual({ width: 1080, height: 2400 });
  });

  it("filters log lines and keeps the last ones", () => {
    expect(filterLogLines("a one\nb two\nA three\n\n", "a", 5)).toEqual(["a one", "A three"]);
    expect(filterLogLines("1\n2\n3\n", undefined, 2)).toEqual(["2", "3"]);
  });
});

describe("device shell arguments", () => {
  it("quotes values the device shell would otherwise split or expand", () => {
    expect(deviceShellQuote("com.example.app")).toBe("com.example.app");
    expect(deviceShellQuote("https://example.com/?a=1&b=2")).toBe("'https://example.com/?a=1&b=2'");
    expect(deviceShellQuote("it's")).toBe(`'it'\\''s'`);
    expect(deviceShellCommand(["am", "start", "-d", "x y"])).toBe("am start -d 'x y'");
  });

  it("encodes spaces for input text and refuses what adb cannot type", () => {
    expect(inputTextArgument("hello world")).toBe("hello%sworld");
    expect(() => inputTextArgument("héllo")).toThrow(/printable ASCII/u);
    expect(deviceShellCommand(["input", "text", inputTextArgument("a;b $HOME")])).toBe("input text 'a;b%s$HOME'");
  });

  it("finds the port to reverse for localhost dev servers", () => {
    expect(localhostPort("http://localhost:8081/")).toBe(8081);
    expect(localhostPort("http://127.0.0.1/")).toBe(80);
    expect(localhostPort("exp://localhost")).toBe(8081);
    expect(localhostPort("exp://127.0.0.1:19000")).toBe(19000);
    expect(localhostPort("https://example.com")).toBeUndefined();
    expect(localhostPort("not a url")).toBeUndefined();
  });
});

describe("emulator boot arguments", () => {
  it("boots headless with a fixed console port", () => {
    expect(emulatorBootArgs("Pixel_7", 5556, {})).toEqual([
      "-avd",
      "Pixel_7",
      "-port",
      "5556",
      "-no-snapshot-save",
      "-no-boot-anim",
      "-netdelay",
      "none",
      "-netspeed",
      "full",
      "-no-window",
    ]);
    const windowed = emulatorBootArgs("Pixel_7", 5554, { window: true, wipeData: true });
    expect(windowed).not.toContain("-no-window");
    expect(windowed).toContain("-wipe-data");
  });
});
