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

/** Where a desktop can be reached through a relay. The URL comes from the pairing code, not from code. */
export const RelayRoute = z.object({
  url: z
    .string()
    .url()
    .startsWith("wss://")
    .refine((value) => {
      // new URL throws on garbage that .url() already flagged, and zod still runs this refine.
      try {
        const parsed = new URL(value);
        return parsed.search === "" && parsed.hash === "" && parsed.username === "" && parsed.password === "";
      } catch {
        return false;
      }
    }, "The relay URL can't carry a query, fragment, or credentials."),
  room: Id16,
});
export type RelayRoute = z.infer<typeof RelayRoute>;

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

/** An Expo push token, the address Expo's push service delivers to. */
export const PushToken = z
  .string()
  .max(200)
  .regex(/^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]+\]$/u);

export const PushPlatform = z.enum(["ios", "android"]);
export type PushPlatform = z.infer<typeof PushPlatform>;

/** Encrypted messages from the phone that the gateway answers itself instead of passing on. */
export const ClientControl = z.discriminatedUnion("type", [
  z.object({ type: z.literal("gateway.pair"), deviceName: DeviceName }),
  z.object({ type: z.literal("gateway.auth"), credential: Key32 }),
  /** The phone forgets this desktop and asks it to forget the phone too. */
  z.object({ type: z.literal("gateway.unpair") }),
  /**
   * Where the desktop sends push notifications while the phone is not connected. A null token means
   * the phone turned notifications off, so the desktop forgets the one it had.
   */
  z.object({ type: z.literal("gateway.push"), token: PushToken.nullable(), platform: PushPlatform }),
  /**
   * The app left the screen and the system is about to suspend it, so this connection will not show
   * alerts even though it may look open for a while longer.
   */
  z.object({ type: z.literal("gateway.away"), away: z.boolean() }),
]);
export type ClientControl = z.infer<typeof ClientControl>;

export const ServerControl = z.discriminatedUnion("type", [
  z.object({ type: z.literal("gateway.paired"), deviceId: Id16, credential: Key32 }),
  /**
   * The desktop holds a pairing that came through the relay until the person there allows it. Sent again now and then
   * while it waits, so the relay does not close the quiet connection. Only phones that can use the relay ever see it.
   */
  z.object({ type: z.literal("gateway.waiting"), reason: z.literal("approval") }),
  /**
   * The desktop did not allow that pairing: the person refused it, or nobody answered in time. Sent sealed just before
   * the close, because a close code that crossed the relay is not authenticated and older relays replaced it with 1000.
   */
  z.object({ type: z.literal("gateway.denied"), reason: z.enum(["refused", "expired"]) }),
  z.object({
    type: z.literal("gateway.ready"),
    desktopName: z.string().min(1).max(80),
    environmentId: EnvironmentId,
    /** The addresses the desktop listens on now, so the phone can follow a changed LAN address. */
    hosts: z.array(RemoteHost).max(8),
    port: z.number().int().min(1).max(65_535),
    /** The gateway takes gateway.push and gateway.away. Older desktops close the connection on them. */
    push: z.boolean().optional(),
    /**
     * Where the phone reaches this desktop through the relay, so a phone paired before the relay was on (or before its
     * room changed) learns the route. Null means the relay is off. Older desktops leave it out, and the phone keeps what
     * it has.
     */
    relay: RelayRoute.nullable().optional(),
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
  /** The person at the desktop did not allow a pairing that came through the relay, or did not answer in time. */
  pairingDenied: 4005,
  /** Too many attempts from this address. */
  rateLimited: 4029,
  /** The relay has no desktop for this room, or the desktop did not dial back in time. */
  desktopOffline: 4404,
  /** The relay closes a desktop's control socket with this when another desktop claims the room. */
  replaced: 4409,
  /** The desktop runtime is not reachable yet. */
  tryAgain: 1013,
} as const;
