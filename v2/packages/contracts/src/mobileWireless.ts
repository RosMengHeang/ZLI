import { z } from "zod";

const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`, "u");
const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const HOSTNAME = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`, "u");

/**
 * A phone's address on the local network: an IPv4 address or a host name. Both go to adb as one argument, and
 * neither can start with a dash, so adb never reads one as an option.
 */
export const MobileAdbHost = z
  .string()
  .trim()
  .min(1, "Enter the phone's IP address.")
  .max(253)
  .refine(
    (host) => IPV4.test(host) || (HOSTNAME.test(host) && !/^[\d.]+$/u.test(host)),
    "Use an IPv4 address such as 192.168.1.20, or a host name.",
  );

export const MobileAdbPort = z
  .number({ message: "Enter a port from 1 to 65535." })
  .int("Enter a port from 1 to 65535.")
  .min(1, "Enter a port from 1 to 65535.")
  .max(65_535, "Enter a port from 1 to 65535.");

/** The code under Pair device with pairing code on the phone's Wireless debugging screen. */
export const MobilePairingCode = z
  .string()
  .trim()
  .regex(/^\d{6}$/u, "Enter the 6-digit code shown on the phone.");

/**
 * Pairs with an Android 11 or newer phone over Wi-Fi, then connects to it. connectPort is the port under
 * IP address & port on the Wireless debugging screen; without it ZLI looks the port up over mDNS.
 */
export const MobileWifiPairInput = z.object({
  host: MobileAdbHost,
  pairPort: MobileAdbPort,
  code: MobilePairingCode,
  connectPort: MobileAdbPort.optional(),
});
export type MobileWifiPairInput = z.infer<typeof MobileWifiPairInput>;

/** Connects to a phone that already trusts this computer, at the address its Wireless debugging screen shows. */
export const MobileWifiConnectInput = z.object({ host: MobileAdbHost, port: MobileAdbPort });
export type MobileWifiConnectInput = z.infer<typeof MobileWifiConnectInput>;

export const MobileWifiResult = z.object({
  /** False when pairing worked but ZLI could not find the port to connect on. */
  connected: z.boolean(),
  /** The device the phone shows up as once connected. */
  deviceId: z.string().min(1).max(300).optional(),
  message: z.string().max(2_000),
});
export type MobileWifiResult = z.infer<typeof MobileWifiResult>;

export type AdbAddressCheck =
  | { readonly ok: true; readonly host: string; readonly port: number }
  | { readonly ok: false; readonly problem: string };

/** Reads a typed address such as 192.168.1.20:37123, as the phone shows it, into a host and a port. */
export function readAdbAddress(typed: string): AdbAddressCheck {
  const value = typed.trim();
  const colon = value.lastIndexOf(":");
  if (!value) return { ok: false, problem: "Enter the IP address and port, such as 192.168.1.20:37123." };
  if (colon <= 0 || colon === value.length - 1)
    return { ok: false, problem: "Add the port after a colon, such as 192.168.1.20:37123." };
  const host = MobileAdbHost.safeParse(value.slice(0, colon));
  if (!host.success) return { ok: false, problem: host.error.issues[0]?.message ?? "That address is not valid." };
  const portText = value.slice(colon + 1);
  const port = MobileAdbPort.safeParse(/^\d{1,5}$/u.test(portText) ? Number(portText) : Number.NaN);
  if (!port.success) return { ok: false, problem: port.error.issues[0]?.message ?? "That port is not valid." };
  return { ok: true, host: host.data, port: port.data };
}

/** Reads a typed port, or reports what is wrong with it. */
export function readAdbPort(typed: string): { ok: true; port: number } | { ok: false; problem: string } {
  const value = typed.trim();
  const port = MobileAdbPort.safeParse(/^\d{1,5}$/u.test(value) ? Number(value) : Number.NaN);
  return port.success
    ? { ok: true, port: port.data }
    : { ok: false, problem: port.error.issues[0]?.message ?? "Enter a port from 1 to 65535." };
}
