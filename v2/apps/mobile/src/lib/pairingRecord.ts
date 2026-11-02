import type { RemoteReady } from "@zli-v2/remote-protocol";
import { DeviceName, Id16, Key32, RemoteHost } from "@zli-v2/remote-protocol";
import { z } from "zod";

const MAX_HOSTS = 8;

/** What the phone keeps in secure storage to reconnect to one desktop. */
export const StoredPairing = z.object({
  v: z.literal(1),
  desktopName: z.string().min(1).max(80),
  hosts: z.array(RemoteHost).min(1).max(MAX_HOSTS),
  port: z.number().int().min(1).max(65_535),
  desktopKey: Key32,
  deviceId: Id16,
  credential: Key32,
  /** The phone's X25519 secret key. The desktop only knows the public half. */
  phoneSecret: Key32,
  deviceName: DeviceName,
  /** The address that answered last, tried first next time. */
  lastHost: RemoteHost.optional(),
  pairedAt: z.string().min(1),
});
export type StoredPairing = z.infer<typeof StoredPairing>;

export function parseStoredPairing(text: string | null | undefined): StoredPairing | undefined {
  if (!text) return undefined;
  try {
    const parsed = StoredPairing.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function serializePairing(pairing: StoredPairing): string {
  return JSON.stringify(StoredPairing.parse(pairing));
}

/** The address that worked last goes first, then the rest in the desktop's order. */
export function hostsToTry(pairing: Pick<StoredPairing, "hosts" | "lastHost">): string[] {
  const ordered = pairing.lastHost ? [pairing.lastHost, ...pairing.hosts] : [...pairing.hosts];
  return [...new Set(ordered)];
}

/**
 * Follows the desktop after a connection: a laptop that moved to another network reports its new
 * addresses here. Old addresses stay after the new ones, so a phone that returns to the old network
 * can still find it.
 */
export function withReady(pairing: StoredPairing, ready: RemoteReady, host: string): StoredPairing {
  const hosts = [...new Set([...ready.hosts, host, ...pairing.hosts])].slice(0, MAX_HOSTS);
  return { ...pairing, desktopName: ready.desktopName, hosts, port: ready.port, lastHost: host };
}

export function samePairing(left: StoredPairing, right: StoredPairing): boolean {
  return serializePairing(left) === serializePairing(right);
}
