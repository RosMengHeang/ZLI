import { EnvironmentId } from "@zli-v2/contracts";
import { z } from "zod";

export const REMOTE_PROTOCOL_VERSION = 1 as const;

/** The WebSocket path the desktop gateway answers on. */
export const REMOTE_PATH = "/remote";

/** 32 bytes as unpadded base64url: X25519 keys, MACs, secrets, and credentials. */
export const Key32 = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u);
/** 16 random bytes as unpadded base64url: pairing and device ids. */
export const Id16 = z.string().regex(/^[A-Za-z0-9_-]{21}[AQgw]$/u);

export const DeviceName = z.string().trim().min(1).max(60);

/** IPv4 addresses and host names. The gateway lists IPv4 LAN addresses only. */
export const RemoteHost = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.-]+$/u);

export const ClientHello = z.discriminatedUnion("mode", [
  z.object({
    type: z.literal("hello"),
    protocol: z.literal(REMOTE_PROTOCOL_VERSION),
    mode: z.literal("pair"),
    pairingId: Id16,
    clientStatic: Key32,
    clientEphemeral: Key32,
    proof: Key32,
  }),
  z.object({
    type: z.literal("hello"),
    protocol: z.literal(REMOTE_PROTOCOL_VERSION),
    mode: z.literal("resume"),
    deviceId: Id16,
    clientStatic: Key32,
    clientEphemeral: Key32,
    proof: Key32,
  }),
]);
export type ClientHello = z.infer<typeof ClientHello>;

export const ServerWelcome = z.object({
  type: z.literal("welcome"),
  protocol: z.literal(REMOTE_PROTOCOL_VERSION),
  serverEphemeral: Key32,
  proof: Key32,
});
export type ServerWelcome = z.infer<typeof ServerWelcome>;

/** Encrypted messages from the phone that the gateway answers itself instead of passing on. */
export const ClientControl = z.discriminatedUnion("type", [
  z.object({ type: z.literal("gateway.pair"), deviceName: DeviceName }),
  z.object({ type: z.literal("gateway.auth"), credential: Key32 }),
  /** The phone forgets this desktop and asks it to forget the phone too. */
  z.object({ type: z.literal("gateway.unpair") }),
]);
export type ClientControl = z.infer<typeof ClientControl>;

export const ServerControl = z.discriminatedUnion("type", [
  z.object({ type: z.literal("gateway.paired"), deviceId: Id16, credential: Key32 }),
  z.object({
    type: z.literal("gateway.ready"),
    desktopName: z.string().min(1).max(80),
    environmentId: EnvironmentId,
    /** The addresses the desktop listens on now, so the phone can follow a changed LAN address. */
    hosts: z.array(RemoteHost).max(8),
    port: z.number().int().min(1).max(65_535),
  }),
]);
export type ServerControl = z.infer<typeof ServerControl>;

export function isControlType(type: unknown): boolean {
  return typeof type === "string" && type.startsWith("gateway.");
}

/** WebSocket close codes the gateway uses, so the phone can tell what to do next. */
export const RemoteCloseCode = {
  /** A frame failed to decrypt, arrived out of order, or did not parse. */
  protocol: 4000,
  /** The hello proof did not verify. */
  handshake: 4001,
  /** The phone is not paired, was revoked, or its credential did not match. */
  notPaired: 4003,
  /** The pairing code is unknown, expired, or already used. */
  pairingCode: 4004,
  /** Too many attempts from this address. */
  rateLimited: 4029,
  /** The desktop runtime is not reachable yet. */
  tryAgain: 1013,
} as const;
