import { describe, expect, it } from "vitest";
import { emulatorBootArgs } from "./AndroidDriver.js";
import {
  adbConnectArgs,
  adbDisconnectArgs,
  adbPairArgs,
  connectPortFor,
  deviceShellCommand,
  deviceShellQuote,
  emulatorPort,
  filterLogLines,
  freeEmulatorPort,
  inputTextArgument,
  isMdnsSerial,
  isWifiSerial,
  localhostPort,
  parseAdbDevices,
  parseConnectOutput,
  parseEmuAvdName,
  parseMdnsServices,
  parsePairOutput,
  parseWmSize,
  pngSize,
  repairScreencap,
  reverseExtra,
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
        wifi: false,
      },
      { serial: "R58M123ABC", state: "unauthorized", rawState: "unauthorized", emulator: false, wifi: false },
      { serial: "0a1b2c3d", state: "offline", rawState: "offline", emulator: false, wifi: false },
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

describe("the extra Metro reverse", () => {
  it("maps 8081 only for an emulator opening the worktree's own non-default port", () => {
    expect(reverseExtra("exp://localhost:8142", true, 8142)).toBe(8142);
    expect(reverseExtra("myapp://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8142", true, 8142)).toBe(8142);
    expect(reverseExtra("http://127.0.0.1:8142/status", true, 8142)).toBe(8142);
    expect(reverseExtra("exp://localhost:8142", false, 8142)).toBeUndefined();
    expect(reverseExtra("exp://localhost:8081", true, 8081)).toBeUndefined();
    expect(reverseExtra("exp://localhost:9000", true, 8142)).toBeUndefined();
    expect(reverseExtra("exp://localhost:8142", true, undefined)).toBeUndefined();
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
    expect(localhostPort("myapp://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8142")).toBe(8142);
    expect(localhostPort("myapp://expo-development-client/?url=http%3A%2F%2Fexample.com%3A8142")).toBeUndefined();
    expect(localhostPort("myapp://open?url=myapp%3A%2F%2Flocalhost%3A1")).toBeUndefined();
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

describe("adb over Wi-Fi", () => {
  it("lists host:port and mDNS phones as Wi-Fi, with their states", () => {
    const devices = parseAdbDevices(
      [
        "List of devices attached",
        "192.168.1.20:39457     device product:husky model:Pixel_8_Pro device:husky transport_id:4",
        "adb-R5CT9XYZ-AbC123._adb-tls-connect._tcp device product:dm3q model:SM_S918B device:dm3q transport_id:5",
        "10.0.0.7:5555          offline transport_id:6",
        "192.168.1.31:41003     unauthorized transport_id:7",
      ].join("\n"),
    );
    expect(devices.map(({ serial, state, wifi, model }) => ({ serial, state, wifi, model }))).toEqual([
      { serial: "192.168.1.20:39457", state: "online", wifi: true, model: "Pixel 8 Pro" },
      { serial: "adb-R5CT9XYZ-AbC123._adb-tls-connect._tcp", state: "online", wifi: true, model: "SM S918B" },
      { serial: "10.0.0.7:5555", state: "offline", wifi: true, model: undefined },
      { serial: "192.168.1.31:41003", state: "unauthorized", wifi: true, model: undefined },
    ]);
  });

  it("drops an mDNS entry for a phone already listed by address or on its USB cable", () => {
    const serials = parseAdbDevices(
      [
        "List of devices attached",
        "adb-28041FDH2000ZK-vWgJpq._adb-tls-connect._tcp. device product:husky model:Pixel_8_Pro device:husky transport_id:3",
        "192.168.1.20:39457     device product:husky model:Pixel_8_Pro device:husky transport_id:4",
        "R5CT9XYZ               device usb:1-2 product:dm3q model:SM_S918B device:dm3q transport_id:5",
        "adb-R5CT9XYZ-AbC123._adb-tls-connect._tcp device product:dm3q model:SM_S918B device:dm3q transport_id:6",
        "emulator-5554          device product:sdk_gphone64 model:sdk_gphone64 device:emu64xa transport_id:1",
      ].join("\n"),
    ).map((device) => device.serial);
    expect(serials).toEqual(["192.168.1.20:39457", "R5CT9XYZ", "emulator-5554"]);
    expect(isWifiSerial("R5CT9XYZ")).toBe(false);
    expect(isWifiSerial("emulator-5554")).toBe(false);
    expect(isMdnsSerial("adb-R5CT9XYZ-AbC123._adb-tls-connect._tcp")).toBe(true);
  });

  it("builds pair, connect, and disconnect arguments with each value as its own argument", () => {
    expect(adbPairArgs("192.168.1.20", 37_123, "123456")).toEqual(["pair", "192.168.1.20:37123", "123456"]);
    expect(adbConnectArgs("pixel.local", 39_457)).toEqual(["connect", "pixel.local:39457"]);
    expect(adbDisconnectArgs("192.168.1.20:39457")).toEqual(["disconnect", "192.168.1.20:39457"]);
  });

  it("reads adb pair's answers", () => {
    const address = "192.168.1.20:37123";
    expect(
      parsePairOutput("Successfully paired to 192.168.1.20:37123 [guid=adb-28041FDH2000ZK-vWgJpq]\n", address),
    ).toEqual({ ok: true, guid: "adb-28041FDH2000ZK-vWgJpq" });
    expect(parsePairOutput("Successfully paired to 192.168.1.20:37123", address)).toEqual({ ok: true });
    expect(parsePairOutput("Failed: Wrong password or connection was dropped.", address)).toMatchObject({
      ok: false,
      problem: expect.stringContaining("did not accept that code"),
    });
    expect(parsePairOutput("Failed: Unable to start pairing client.", address)).toMatchObject({
      ok: false,
      problem: expect.stringContaining("Nothing answered at 192.168.1.20:37123"),
    });
    expect(parsePairOutput("adb: unknown command pair", address)).toMatchObject({
      ok: false,
      problem: expect.stringContaining("too old"),
    });
    expect(parsePairOutput("error: something new", address)).toEqual({
      ok: false,
      problem: "Pairing failed: error: something new",
    });
    expect(parsePairOutput("", address)).toMatchObject({ ok: false });
  });

  it("reads adb connect's answers, which come with exit code 0 either way", () => {
    const address = "192.168.1.20:39457";
    expect(parseConnectOutput("connected to 192.168.1.20:39457", address)).toEqual({ ok: true });
    expect(parseConnectOutput("already connected to 192.168.1.20:39457", address)).toEqual({ ok: true });
    expect(parseConnectOutput("failed to authenticate to 192.168.1.20:39457", address)).toMatchObject({
      ok: false,
      problem: expect.stringContaining("Pair it with a code first"),
    });
    expect(parseConnectOutput("failed to connect to '192.168.1.20:39457': Connection refused", address)).toMatchObject({
      ok: false,
      problem: expect.stringContaining("Nothing answered at 192.168.1.20:39457"),
    });
    expect(
      parseConnectOutput(
        "cannot connect to 192.168.1.20:39457: A connection attempt failed because the connected party did not properly respond after a period of time (10060)",
        address,
      ),
    ).toMatchObject({ ok: false, problem: expect.stringContaining("cannot reach 192.168.1.20") });
    expect(parseConnectOutput("failed to connect to 192.168.1.20:39457: No route to host", address)).toMatchObject({
      ok: false,
      problem: expect.stringContaining("same Wi-Fi network"),
    });
  });

  it("finds the connect port from adb mdns services", () => {
    const services = parseMdnsServices(
      [
        "List of discovered mdns services",
        "adb-28041FDH2000ZK-vWgJpq\t_adb-tls-connect._tcp.\t192.168.1.20:39457",
        "adb-28041FDH2000ZK-vWgJpq\t_adb-tls-pairing._tcp.\t192.168.1.20:37123",
        "adb-R5CT9XYZ-AbC123\t_adb-tls-connect._tcp\t192.168.1.31:41003",
      ].join("\n"),
    );
    expect(services).toEqual([
      { name: "adb-28041FDH2000ZK-vWgJpq", type: "connect", host: "192.168.1.20", port: 39_457 },
      { name: "adb-28041FDH2000ZK-vWgJpq", type: "pairing", host: "192.168.1.20", port: 37_123 },
      { name: "adb-R5CT9XYZ-AbC123", type: "connect", host: "192.168.1.31", port: 41_003 },
    ]);
    expect(connectPortFor(services, "192.168.1.99", "adb-28041FDH2000ZK-vWgJpq")).toBe(39_457);
    expect(connectPortFor(services, "192.168.1.31", undefined)).toBe(41_003);
    expect(connectPortFor(services, "192.168.1.40", undefined)).toBeUndefined();
  });
});
