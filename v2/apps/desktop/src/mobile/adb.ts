import type { MobileButton, MobileDeviceState } from "@zli-v2/contracts";

export type AdbDevice = {
  readonly serial: string;
  readonly state: MobileDeviceState;
  readonly rawState: string;
  readonly model?: string;
  readonly product?: string;
  readonly emulator: boolean;
};

/** Parses `adb devices -l`. Unknown states such as "recovery" count as offline. */
export function parseAdbDevices(output: string): AdbDevice[] {
  const devices: AdbDevice[] = [];
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
    devices.push({
      serial,
      state,
      rawState,
      ...(fields.model ? { model: fields.model.replaceAll("_", " ") } : {}),
      ...(fields.product ? { product: fields.product } : {}),
      emulator: /^emulator-\d+$/u.test(serial),
    });
  }
  return devices;
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
  if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) return undefined;
  if (parsed.port) return Number(parsed.port);
  if (parsed.protocol === "http:") return 80;
  if (parsed.protocol === "https:") return 443;
  // Expo Go links default to Metro's port.
  if (parsed.protocol === "exp:") return 8081;
  return undefined;
}

export function filterLogLines(output: string, filter: string | undefined, lines: number): string[] {
  const needle = filter?.toLowerCase();
  const all = output.split(/\r?\n/u).filter((line) => line.trim() && (!needle || line.toLowerCase().includes(needle)));
  return all.slice(-lines);
}
