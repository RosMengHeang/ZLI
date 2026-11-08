import { describe, expect, it } from "vitest";

import {
  MobileAdbHost,
  MobileWifiConnectInput,
  MobileWifiPairInput,
  readAdbAddress,
  readAdbPort,
} from "./mobileWireless.js";

describe("mobile Wi-Fi inputs", () => {
  it("takes IPv4 addresses and host names, and refuses anything adb could read as an option or a list", () => {
    for (const host of ["192.168.1.20", "10.0.0.1", "pixel-8.local", "phone"])
      expect(MobileAdbHost.safeParse(host).success).toBe(true);
    for (const host of [
      "",
      "-s",
      "--help",
      "256.1.1.1",
      "1.2.3",
      "a b",
      "host;reboot",
      "$(reboot)",
      "a:b",
      "x".repeat(254),
    ])
      expect(MobileAdbHost.safeParse(host).success).toBe(false);
  });

  it("checks the port range and the 6-digit code", () => {
    const pair = { host: "192.168.1.20", pairPort: 37_123, code: "123456" };
    expect(MobileWifiPairInput.parse({ ...pair, connectPort: 39_457 })).toEqual({ ...pair, connectPort: 39_457 });
    expect(MobileWifiPairInput.safeParse({ ...pair, code: "12345" }).success).toBe(false);
    expect(MobileWifiPairInput.safeParse({ ...pair, code: "12345a" }).success).toBe(false);
    expect(MobileWifiPairInput.safeParse({ ...pair, code: "123456 --x" }).success).toBe(false);
    expect(MobileWifiPairInput.safeParse({ ...pair, pairPort: 0 }).success).toBe(false);
    expect(MobileWifiPairInput.safeParse({ ...pair, pairPort: 65_536 }).success).toBe(false);
    expect(MobileWifiPairInput.safeParse({ ...pair, pairPort: 1.5 }).success).toBe(false);
    expect(MobileWifiConnectInput.safeParse({ host: "192.168.1.20", port: 5555 }).success).toBe(true);
  });

  it("reads a typed address the way the phone shows it", () => {
    expect(readAdbAddress(" 192.168.1.20:37123 ")).toEqual({ ok: true, host: "192.168.1.20", port: 37_123 });
    expect(readAdbAddress("pixel.local:5555")).toEqual({ ok: true, host: "pixel.local", port: 5555 });
    expect(readAdbAddress("")).toMatchObject({ ok: false, problem: expect.stringContaining("IP address and port") });
    expect(readAdbAddress("192.168.1.20")).toMatchObject({ ok: false, problem: expect.stringContaining("colon") });
    expect(readAdbAddress("192.168.1.20:")).toMatchObject({ ok: false });
    expect(readAdbAddress("192.168.1.20:99999")).toEqual({ ok: false, problem: "Enter a port from 1 to 65535." });
    expect(readAdbAddress("192.168.1.20:12ab")).toMatchObject({ ok: false });
    expect(readAdbAddress("-s:5555")).toMatchObject({ ok: false });
    expect(readAdbPort("39457")).toEqual({ ok: true, port: 39_457 });
    expect(readAdbPort("0")).toMatchObject({ ok: false });
  });
});
