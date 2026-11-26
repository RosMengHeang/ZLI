import { z } from "zod";

import { toBase64Url } from "./bytes.js";
import { hashSecret } from "./crypto.js";
import { Id16, Key32, RelayRoute } from "./messages.js";

/*
 * The relay is an untrusted byte pipe. It only sees the room id and ciphertext: the handshake and
 * channel encryption run end to end between phone and desktop, so the relay URL is data (carried in
 * the pairing code), never a trust anchor.
 */

/** The room is derived from the pairing secret so the relay can't link rooms to anything else. */
export function roomIdFromSecret(secret: Uint8Array): string {
  return toBase64Url(hashSecret(secret).slice(0, 16));
}

export function relayUrl(route: RelayRoute, role: "phone" | "host", session?: string): string {
  const { url, room } = RelayRoute.parse(route);
  const path = `${url.replace(/\/+$/u, "")}/v1/${role}/${room}`;
  // The session lands in the path, so it must be a plain id and never something like "../x".
  return session === undefined ? path : `${path}/${Id16.parse(session)}`;
}

/** Control messages between the desktop and the relay. Everything else on the wire is opaque. */
export const RelayHostMessage = z.discriminatedUnion("type", [
  /** Host to relay: take ownership of the room with its secret. */
  z.object({ type: z.literal("claim"), secret: Key32 }),
  /** Relay to host: a phone connected. `client` is an opaque per-client key (a hash of its IP). */
  z.object({ type: z.literal("open"), session: Id16, client: z.string().min(1).max(64) }),
  /** Host to relay: keep the connection alive. */
  z.object({ type: z.literal("ping") }),
  /** Relay to host: the runtime's own answer to a ping, sent without waking the room. */
  z.object({ type: z.literal("pong") }),
  /** Relay to host: the daily message budget is used up. */
  z.object({ type: z.literal("budget") }),
]);
export type RelayHostMessage = z.infer<typeof RelayHostMessage>;
