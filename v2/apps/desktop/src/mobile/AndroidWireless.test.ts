import type { MobileDevice } from "@zli-v2/contracts";
import { describe, expect, it, vi } from "vitest";

import { AndroidWireless } from "./AndroidWireless.js";
import { FakeProcessRunner, type FakeRunHandler } from "./FakeProcessRunner.js";
import { MobileDriverError } from "./MobileDriver.js";

const ADB = "/sdk/platform-tools/adb";
const PAIRED = "Successfully paired to 192.168.1.20:37123 [guid=adb-28041FDH2000ZK-vWgJpq]\n";
const MDNS = [
  "List of discovered mdns services",
  "adb-28041FDH2000ZK-vWgJpq\t_adb-tls-connect._tcp.\t192.168.1.20:39457",
  "adb-28041FDH2000ZK-vWgJpq\t_adb-tls-pairing._tcp.\t192.168.1.20:37123",
].join("\n");

const phone: MobileDevice = {
  deviceId: "android:192.168.1.20:39457",
  platform: "android",
  kind: "physical",
  name: "Pixel 8 Pro",
  state: "online",
  serial: "192.168.1.20:39457",
  connection: "wifi",
  lease: null,
};

function wireless(handler: FakeRunHandler, devices: MobileDevice[] = [phone], adb: string | null = ADB) {
  const runner = new FakeProcessRunner(handler);
  const manager = {
    find: vi.fn(async (deviceId: string) => {
      const device = devices.find((entry) => entry.deviceId === deviceId);
      if (!device) throw new MobileDriverError(`No device ${deviceId}.`, 404);
      return device;
    }),
    list: vi.fn(async () => devices),
    stopStream: vi.fn(async () => undefined),
  };
  const subject = new AndroidWireless({
    runner,
    tools: async () => ({ ...(adb ? { adb } : {}), env: { ANDROID_HOME: "/sdk" } }),
    manager,
    sleep: async () => undefined,
    mdnsAttempts: 2,
  });
  return { runner, manager, subject };
}

describe("Android over Wi-Fi", () => {
  it("pairs with the code, then connects on the port the person typed", async () => {
    const { runner, subject } = wireless((_command, args) => {
      if (args[0] === "pair") return { stdout: PAIRED };
      if (args[0] === "connect") return { stdout: "connected to 192.168.1.20:39457\n" };
      return undefined;
    });
    expect(await subject.pair({ host: "192.168.1.20", pairPort: 37_123, code: "123456", connectPort: 39_457 })).toEqual(
      {
        connected: true,
        deviceId: "android:192.168.1.20:39457",
        message: "Paired and connected to Pixel 8 Pro.",
      },
    );
    expect(runner.argsOf("adb")).toEqual([
      ["pair", "192.168.1.20:37123", "123456"],
      ["connect", "192.168.1.20:39457"],
    ]);
    expect(runner.calls[0]?.options).toMatchObject({ env: { ANDROID_HOME: "/sdk" } });
  });

  it("looks the connect port up over mDNS when the person left it out", async () => {
    let lookups = 0;
    const { runner, subject } = wireless((_command, args) => {
      if (args[0] === "pair") return { stdout: PAIRED };
      if (args.join(" ") === "mdns services") {
        lookups += 1;
        return { stdout: lookups === 1 ? "List of discovered mdns services\n" : MDNS };
      }
      if (args[0] === "connect") return { stdout: "connected to 192.168.1.20:39457\n" };
      return undefined;
    });
    const result = await subject.pair({ host: "192.168.1.20", pairPort: 37_123, code: "123456" });
    expect(result).toMatchObject({ connected: true, deviceId: "android:192.168.1.20:39457" });
    expect(runner.argsOf("adb").at(-1)).toEqual(["connect", "192.168.1.20:39457"]);
  });

  it("reports a pairing without a connection when mDNS does not find the phone", async () => {
    const { runner, subject } = wireless((_command, args) => (args[0] === "pair" ? { stdout: PAIRED } : undefined));
    expect(await subject.pair({ host: "192.168.1.20", pairPort: 37_123, code: "123456" })).toEqual({
      connected: false,
      message:
        "Paired with the phone. Enter the port under IP address & port on its Wireless debugging screen to connect.",
    });
    expect(runner.argsOf("adb").filter((args) => args[0] === "connect")).toEqual([]);
  });

  it("turns a refused code or an unreachable phone into a plain reason, even when adb exits 0", async () => {
    const refused = wireless(() => ({ stdout: "Failed: Wrong password or connection was dropped.\n" }));
    await expect(refused.subject.pair({ host: "192.168.1.20", pairPort: 37_123, code: "000000" })).rejects.toThrow(
      "The phone did not accept that code.",
    );
    expect(refused.runner.argsOf("adb")).toHaveLength(1);

    const unreachable = wireless(() => ({
      stdout: "failed to connect to '192.168.1.20:39457': Connection refused\n",
    }));
    await expect(unreachable.subject.connect({ host: "192.168.1.20", port: 39_457 })).rejects.toThrow(
      "Nothing answered at 192.168.1.20:39457.",
    );

    const timedOut = wireless(() => ({ timedOut: true, code: null }));
    await expect(timedOut.subject.connect({ host: "192.168.1.20", port: 39_457 })).rejects.toThrow(
      "adb connect did not finish in time.",
    );

    const missing = wireless(() => undefined, [phone], null);
    await expect(missing.subject.connect({ host: "192.168.1.20", port: 39_457 })).rejects.toThrow(
      "adb is not installed",
    );
    expect(missing.runner.calls).toEqual([]);
  });

  it("connects to a known address and names the phone once adb lists it", async () => {
    const { subject } = wireless(() => ({ stdout: "already connected to 192.168.1.20:39457\n" }));
    expect(await subject.connect({ host: "192.168.1.20", port: 39_457 })).toEqual({
      connected: true,
      deviceId: "android:192.168.1.20:39457",
      message: "Connected to Pixel 8 Pro.",
    });
    const unnamed = wireless(() => ({ stdout: "connected to 10.0.0.7:5555\n" }), []);
    expect(await unnamed.subject.connect({ host: "10.0.0.7", port: 5555 })).toMatchObject({
      message: "Connected to 10.0.0.7:5555.",
    });
  });

  it("disconnects a Wi-Fi phone after stopping its stream, and refuses a phone on a cable", async () => {
    const usb: MobileDevice = { ...phone, deviceId: "android:R58M", serial: "R58M", connection: "usb" };
    const { runner, manager, subject } = wireless(
      () => ({ stdout: "disconnected 192.168.1.20:39457\n" }),
      [phone, usb],
    );
    await subject.disconnect(phone.deviceId);
    expect(manager.stopStream).toHaveBeenCalledWith(phone.deviceId);
    expect(runner.argsOf("adb")).toEqual([["disconnect", "192.168.1.20:39457"]]);
    expect(manager.list).toHaveBeenCalled();
    await expect(subject.disconnect(usb.deviceId)).rejects.toThrow("is not connected over Wi-Fi");
    expect(runner.argsOf("adb")).toHaveLength(1);
  });

  it("disconnects a phone adb found over mDNS through the address mDNS gives for it", async () => {
    const serial = "adb-28041FDH2000ZK-vWgJpq._adb-tls-connect._tcp";
    const mdnsPhone: MobileDevice = { ...phone, deviceId: `android:${serial}`, serial };
    const { runner, subject } = wireless(
      (_command, args) => {
        if (args.join(" ") === `disconnect ${serial}`) return { stdout: `error: no such device '${serial}'\n` };
        if (args.join(" ") === "mdns services") return { stdout: MDNS };
        return { stdout: "disconnected 192.168.1.20:39457\n" };
      },
      [mdnsPhone],
    );
    await subject.disconnect(mdnsPhone.deviceId);
    expect(runner.argsOf("adb")).toEqual([
      ["disconnect", serial],
      ["mdns", "services"],
      ["disconnect", "192.168.1.20:39457"],
    ]);
  });
});
