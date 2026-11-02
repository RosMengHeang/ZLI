import type { MobileWifiConnectInput, MobileWifiPairInput, MobileWifiResult } from "@zli-v2/contracts";

import { androidDeviceId } from "./AndroidDriver.js";
import {
  adbConnectArgs,
  adbDisconnectArgs,
  adbPairArgs,
  connectPortFor,
  isMdnsSerial,
  parseConnectOutput,
  parseMdnsServices,
  parsePairOutput,
} from "./adb.js";
import type { DeviceManager } from "./DeviceManager.js";
import { MobileDriverError } from "./MobileDriver.js";
import type { ProcessRunner } from "./ProcessRunner.js";

export type AndroidWirelessDeps = {
  readonly runner: ProcessRunner;
  /** adb and the environment to run it in, re-read on every call like the driver's tools. */
  readonly tools: () => Promise<{ readonly adb?: string; readonly env: NodeJS.ProcessEnv }>;
  readonly manager: Pick<DeviceManager, "find" | "list" | "stopStream">;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** How many times to look for the connect port after pairing, since the phone can take a moment to advertise. */
  readonly mdnsAttempts?: number;
};

const PAIR_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 20_000;
const MDNS_TIMEOUT_MS = 10_000;

/**
 * Wireless debugging for Android 11 and newer: pair with the code the phone shows, connect to the port its
 * Wireless debugging screen shows, and disconnect. Every value reaches adb as its own argument, never through a
 * shell, and the IPC layer has already checked it against the contract.
 */
export class AndroidWireless {
  readonly #deps: AndroidWirelessDeps;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(deps: AndroidWirelessDeps) {
    this.#deps = deps;
    this.#sleep = deps.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async pair(input: MobileWifiPairInput): Promise<MobileWifiResult> {
    const address = `${input.host}:${input.pairPort}`;
    const paired = parsePairOutput(
      await this.#adb(adbPairArgs(input.host, input.pairPort, input.code), PAIR_TIMEOUT_MS),
      address,
    );
    if (!paired.ok) throw new MobileDriverError(paired.problem, 400);
    const port = input.connectPort ?? (await this.#findConnectPort(input.host, paired.guid));
    if (port === undefined)
      return {
        connected: false,
        message:
          "Paired with the phone. Enter the port under IP address & port on its Wireless debugging screen to connect.",
      };
    return this.connect({ host: input.host, port }, "Paired and connected");
  }

  async connect(input: MobileWifiConnectInput, done = "Connected"): Promise<MobileWifiResult> {
    const address = `${input.host}:${input.port}`;
    const outcome = parseConnectOutput(
      await this.#adb(adbConnectArgs(input.host, input.port), CONNECT_TIMEOUT_MS),
      address,
    );
    if (!outcome.ok) throw new MobileDriverError(outcome.problem, 400);
    const deviceId = androidDeviceId({ serial: address });
    const listed = (await this.#deps.manager.list()).find((device) => device.deviceId === deviceId);
    const name = listed && listed.name !== address ? listed.name : address;
    return { connected: true, deviceId, message: `${done} to ${name}.` };
  }

  /** Disconnects a phone reached over Wi-Fi. A phone on a cable stays connected; unplug it instead. */
  async disconnect(deviceId: string): Promise<void> {
    const device = await this.#deps.manager.find(deviceId);
    if (device.platform !== "android" || device.connection !== "wifi" || !device.serial)
      throw new MobileDriverError(
        `${device.name} is not connected over Wi-Fi, so there is nothing to disconnect.`,
        409,
      );
    await this.#deps.manager.stopStream(deviceId);
    const serial = device.serial;
    let output = await this.#adb(adbDisconnectArgs(serial), CONNECT_TIMEOUT_MS);
    if (/error|no such device/iu.test(output) && isMdnsSerial(serial)) {
      // adb names a phone it found over mDNS by its service, which older adb cannot disconnect by name.
      const services = parseMdnsServices(await this.#adb(["mdns", "services"], MDNS_TIMEOUT_MS).catch(() => ""));
      const service = services.find((entry) => entry.type === "connect" && serial.startsWith(`${entry.name}.`));
      if (service) output = await this.#adb(adbDisconnectArgs(`${service.host}:${service.port}`), CONNECT_TIMEOUT_MS);
    }
    await this.#deps.manager.list();
    if (/error|no such device/iu.test(output))
      throw new MobileDriverError(`adb could not disconnect ${device.name}: ${output.trim().slice(-500)}`, 500);
  }

  async #findConnectPort(host: string, guid: string | undefined): Promise<number | undefined> {
    const attempts = this.#deps.mdnsAttempts ?? 4;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await this.#sleep(1_000);
      const output = await this.#adb(["mdns", "services"], MDNS_TIMEOUT_MS).catch(() => "");
      const port = connectPortFor(parseMdnsServices(output), host, guid);
      if (port !== undefined) return port;
    }
    return undefined;
  }

  /** stdout and stderr together, because adb prints its pair and connect answers to either. */
  async #adb(args: readonly string[], timeoutMs: number): Promise<string> {
    const tools = await this.#deps.tools();
    if (!tools.adb)
      throw new MobileDriverError(
        "adb is not installed. Install the Android platform tools from Setup in the Mobile panel.",
        409,
      );
    const result = await this.#deps.runner.run(tools.adb, args, { env: tools.env, timeoutMs });
    if (result.timedOut) throw new MobileDriverError(`adb ${args[0] ?? ""} did not finish in time.`, 504);
    return `${result.stdout.toString("utf8")}\n${result.stderr}`.trim();
  }
}
