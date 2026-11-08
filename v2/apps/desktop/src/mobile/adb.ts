import { METRO_DEFAULT_PORT, type MobileButton, type MobileDeviceState } from "@zli-v2/contracts";

export type AdbDevice = {
  readonly serial: string;
  readonly state: MobileDeviceState;
  readonly rawState: string;
  readonly model?: string;
  readonly product?: string;
  readonly emulator: boolean;
  /** Reached over the network: a host:port serial, or an mDNS service name adb connected to on its own. */
  readonly wifi: boolean;
};

/** adb's name for a phone it found and connected to over mDNS, with the phone's own serial number inside. */
const MDNS_CONNECT = /^adb-(.+?)(?:-[A-Za-z0-9]{6})?\._adb-tls-connect\._tcp\.?$/u;
const HOST_PORT = /^[^\s:]+:\d{1,5}$/u;

export function isMdnsSerial(serial: string): boolean {
  return MDNS_CONNECT.test(serial);
}

/** A serial adb reaches over the network rather than a cable or the emulator console. */
export function isWifiSerial(serial: string): boolean {
  return HOST_PORT.test(serial) || isMdnsSerial(serial);
}

/**
 * Parses `adb devices -l`. Unknown states such as "recovery" count as offline. A phone adb reaches both by its
 * mDNS name and by another serial is listed once: the mDNS entry is dropped when the phone's serial number is
 * plugged in over USB, or when a host:port entry reports the same model, product, and device.
 */
export function parseAdbDevices(output: string): AdbDevice[] {
  const entries: { device: AdbDevice; fields: Record<string, string> }[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("List of devices") || trimmed.startsWith("*")) continue;
    const [serial, rawState = "", ...details] = trimmed.split(/\s+/u);
    if (!serial) continue;
    const fields = Object.fromEntries(
      details.flatMap((detail) => {
        const index = detail.indexOf(":");
        return index > 0 ? [[detail.slice(0, index), detail.slice(index + 1)]] : [];
      }),
    ) as Record<string, string>;
    const state: MobileDeviceState =
      rawState === "device" ? "online" : rawState === "unauthorized" ? "unauthorized" : "offline";
    const emulator = /^emulator-\d+$/u.test(serial);
    entries.push({
      fields,
      device: {
        serial,
        state,
        rawState,
        ...(fields.model ? { model: fields.model.replaceAll("_", " ") } : {}),
        ...(fields.product ? { product: fields.product } : {}),
        emulator,
        wifi: !emulator && isWifiSerial(serial),
      },
    });
  }
  const sameHardware = (a: Record<string, string>, b: Record<string, string>) =>
    Boolean(a.model && a.product && a.device) &&
    a.model === b.model &&
    a.product === b.product &&
    a.device === b.device;
  return entries
    .filter((entry) => {
      const inner = MDNS_CONNECT.exec(entry.device.serial)?.[1];
      if (!inner) return true;
      return !entries.some(
        (other) =>
          other !== entry &&
          !isMdnsSerial(other.device.serial) &&
          (other.device.serial === inner || (other.device.wifi && sameHardware(entry.fields, other.fields))),
      );
    })
    .map((entry) => entry.device);
}
/** The emulator console port behind an emulator-NNNN serial. */
export function emulatorPort(serial: string): number | undefined {
  const match = /^emulator-(\d+)$/u.exec(serial);
  return match?.[1] ? Number(match[1]) : undefined;
}

/** The lowest even console port from 5554 that no running emulator uses. */
export function freeEmulatorPort(serials: readonly string[]): number {
  const used = new Set(serials.map(emulatorPort).filter((port): port is number => port !== undefined));
  for (let port = 5554; port <= 5682; port += 2) if (!used.has(port)) return port;
  throw new Error("Every emulator port from 5554 to 5682 is in use.");
}

/** `adb emu avd name` answers with the AVD name and then OK. */
export function parseEmuAvdName(output: string): string | undefined {
  const first = output.split(/\r?\n/u)[0]?.trim();
  return first && first !== "OK" && !first.startsWith("KO") ? first : undefined;
}

/** `adb shell` joins its arguments and hands them to the device's sh, so each one is quoted for sh. */
export function deviceShellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function deviceShellCommand(args: readonly string[]): string {
  return args.map(deviceShellQuote).join(" ");
}

/**
 * Text for `input text`, which reads %s as a space and cannot type other whitespace. Characters outside
 * printable ASCII are refused because `input text` silently drops them.
 */
export function inputTextArgument(text: string): string {
  if (/[^\x20-\x7e]/u.test(text))
    throw new Error(
      "adb can type only printable ASCII. Keep the Mobile panel open to type other characters through scrcpy.",
    );
  return text.replaceAll(" ", "%s");
}

export const ANDROID_KEYCODES: Record<MobileButton, number> = {
  back: 4,
  home: 3,
  recents: 187,
  power: 26,
  volume_up: 24,
  volume_down: 25,
  enter: 66,
  delete: 67,
  tab: 61,
  dpad_up: 19,
  dpad_down: 20,
  dpad_left: 21,
  dpad_right: 22,
};

export const ANDROID_ROTATIONS = {
  portrait: 0,
  landscape: 1,
  "portrait-reverse": 2,
  "landscape-reverse": 3,
} as const;

/** Parses `wm size`, preferring an override size because that is what apps lay out against. */
export function parseWmSize(output: string): { width: number; height: number } | undefined {
  const override = /Override size:\s*(\d+)x(\d+)/u.exec(output);
  const physical = /Physical size:\s*(\d+)x(\d+)/u.exec(output);
  const match = override ?? physical;
  return match ? { width: Number(match[1]), height: Number(match[2]) } : undefined;
}

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(data: Buffer): { width: number; height: number } | undefined {
  if (data.length < 24 || data.readUInt32BE(0) !== 0x89504e47 || data.subarray(12, 16).toString("ascii") !== "IHDR")
    return undefined;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

/** Older adb versions turn \n into \r\n on exec-out on Windows; a PNG that starts damaged is repaired here. */
export function repairScreencap(data: Buffer): Buffer {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return data;
  if (data.subarray(0, 9).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0d, 0x0a, 0x1a, 0x0d]))) {
    const bytes: number[] = [];
    for (let index = 0; index < data.length; index += 1) {
      const byte = data[index] as number;
      if (byte === 0x0d && data[index + 1] === 0x0a) continue;
      bytes.push(byte);
    }
    return Buffer.from(bytes);
  }
  return data;
}

/** The port to reverse so a device can reach a dev server on the host's localhost, or undefined. */
export function localhostPort(url: string): number | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
    // A development build's link carries the Metro URL in its url parameter.
    const inner = parsed.searchParams.get("url");
    return inner && /^https?:/iu.test(inner) ? localhostPort(inner) : undefined;
  }
  if (parsed.port) return Number(parsed.port);
  if (parsed.protocol === "http:") return 80;
  if (parsed.protocol === "https:") return 443;
  // Expo Go links default to Metro's port.
  if (parsed.protocol === "exp:") return METRO_DEFAULT_PORT;
  return undefined;
}

/**
 * The Metro port an emulator's own localhost:8081 should also reach, so an app built for 8081 loads this
 * worktree's bundle. Only for emulators opening this worktree's port; physical phones are left alone.
 */
export function reverseExtra(url: string, emulator: boolean, metroPort: number | undefined): number | undefined {
  if (!emulator || metroPort === undefined || metroPort === METRO_DEFAULT_PORT) return undefined;
  return localhostPort(url) === metroPort ? metroPort : undefined;
}

export function filterLogLines(output: string, filter: string | undefined, lines: number): string[] {
  const needle = filter?.toLowerCase();
  const all = output.split(/\r?\n/u).filter((line) => line.trim() && (!needle || line.toLowerCase().includes(needle)));
  return all.slice(-lines);
}

/** `adb pair host:port code`. The code is an argument, so adb does not stop to ask for it. */
export function adbPairArgs(host: string, port: number, code: string): string[] {
  return ["pair", `${host}:${port}`, code];
}

export function adbConnectArgs(host: string, port: number): string[] {
  return ["connect", `${host}:${port}`];
}

export function adbDisconnectArgs(serial: string): string[] {
  return ["disconnect", serial];
}

export type AdbPairOutcome =
  | { readonly ok: true; readonly guid?: string }
  | { readonly ok: false; readonly problem: string };

/**
 * Reads what `adb pair` printed. Some adb versions exit 0 after a failed pairing, so the text decides. guid is
 * the phone's mDNS service name, which `adb mdns services` lists with the port to connect on.
 */
export function parsePairOutput(output: string, address: string): AdbPairOutcome {
  const text = output.trim();
  const success = /Successfully paired to \S+(?:\s*\[guid=([^\]\s]+)\])?/iu.exec(text);
  if (success) return success[1] ? { ok: true, guid: success[1] } : { ok: true };
  if (/wrong password|connection was dropped/iu.test(text))
    return {
      ok: false,
      problem:
        "The phone did not accept that code. A code works only while the pairing dialog is open, so open Pair device with pairing code again and enter the new one.",
    };
  if (/unknown command|usage: adb/iu.test(text))
    return {
      ok: false,
      problem: "This adb is too old to pair over Wi-Fi. Update the Android platform tools to version 30 or newer.",
    };
  if (/unable to start pairing client|connection refused|failed to connect|cannot connect/iu.test(text))
    return {
      ok: false,
      problem: `Nothing answered at ${address}. Check the address under Pair device with pairing code; it changes each time the dialog opens.`,
    };
  return {
    ok: false,
    problem: text ? `Pairing failed: ${text.slice(-500)}` : "Pairing failed, and adb gave no reason.",
  };
}

export type AdbConnectOutcome = { readonly ok: true } | { readonly ok: false; readonly problem: string };

/** Reads what `adb connect` printed. adb exits 0 after most failed connections, so the text decides. */
export function parseConnectOutput(output: string, address: string): AdbConnectOutcome {
  const text = output.trim();
  if (/^(?:already )?connected to /imu.test(text)) return { ok: true };
  const host = address.slice(0, address.lastIndexOf(":"));
  if (/failed to authenticate/iu.test(text))
    return { ok: false, problem: "The phone has not trusted this computer yet. Pair it with a code first." };
  if (/connection refused|\(10061\)/iu.test(text))
    return {
      ok: false,
      problem: `Nothing answered at ${address}. Check the port under IP address & port on the Wireless debugging screen; it changes each time wireless debugging is turned on.`,
    };
  if (/no route to host|timed out|unreachable|\(10060\)|\(113\)/iu.test(text))
    return {
      ok: false,
      problem: `This computer cannot reach ${host}. Check that the phone and this computer are on the same Wi-Fi network.`,
    };
  return {
    ok: false,
    problem: text ? `adb could not connect: ${text.slice(-500)}` : "adb could not connect, and gave no reason.",
  };
}

export type AdbMdnsService = {
  readonly name: string;
  readonly type: "connect" | "pairing" | "other";
  readonly host: string;
  readonly port: number;
};

/** Parses `adb mdns services`: one service per line, as name, type, and host:port. */
export function parseMdnsServices(output: string): AdbMdnsService[] {
  const services: AdbMdnsService[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const parts = line.trim().split(/\s+/u);
    if (parts.length < 3) continue;
    const [name = "", type = "", address = ""] = parts;
    const match = /^(.+):(\d{1,5})$/u.exec(address);
    if (!match?.[1] || !match[2]) continue;
    services.push({
      name,
      type: type.startsWith("_adb-tls-connect") ? "connect" : type.startsWith("_adb-tls-pairing") ? "pairing" : "other",
      host: match[1],
      port: Number(match[2]),
    });
  }
  return services;
}

/** The port to connect on after pairing: the service with the pairing guid, or else the only one on that host. */
export function connectPortFor(
  services: readonly AdbMdnsService[],
  host: string,
  guid: string | undefined,
): number | undefined {
  const connect = services.filter((service) => service.type === "connect");
  const named = guid ? connect.find((service) => service.name === guid) : undefined;
  if (named) return named.port;
  const onHost = connect.filter((service) => service.host === host);
  return onHost.length === 1 ? onHost[0]?.port : undefined;
}
