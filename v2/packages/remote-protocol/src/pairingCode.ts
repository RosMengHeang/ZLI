import { z } from "zod";

import { fromBase64Url, toBase64Url, utf8Decode, utf8Encode } from "./bytes.js";
import { Id16, Key32, REMOTE_PROTOCOL_VERSION, RemoteHost } from "./messages.js";

/** Every pairing code starts with this, so a scanner can skip unrelated QR codes. */
export const PAIRING_CODE_PREFIX = "zli-remote:";
const PREFIX = PAIRING_CODE_PREFIX;

/** Everything a phone needs to reach and pair with a desktop. The QR code holds this, encoded. */
export const PairingCode = z.object({
  v: z.literal(REMOTE_PROTOCOL_VERSION),
  /** The desktop's name, shown on the phone before it connects. */
  name: z.string().trim().min(1).max(80),
  hosts: z.array(RemoteHost).min(1).max(8),
  port: z.number().int().min(1).max(65_535),
  /** The desktop's long-lived X25519 public key. */
  key: Key32,
  pairingId: Id16,
  /** One-time secret, valid until `expiresAt` and for a single successful pairing. */
  secret: Key32,
  expiresAt: z.number().int().positive(),
});
export type PairingCode = z.infer<typeof PairingCode>;

export function encodePairingCode(code: PairingCode): string {
  return PREFIX + toBase64Url(utf8Encode(JSON.stringify(PairingCode.parse(code))));
}

export class PairingCodeError extends Error {
  override name = "PairingCodeError";
}

/** Accepts the text a QR scanner returns or a person pastes, with stray whitespace. */
export function decodePairingCode(text: string): PairingCode {
  const trimmed = text.replace(/\s+/gu, "");
  if (!trimmed.startsWith(PREFIX)) throw new PairingCodeError("This is not a ZLI pairing code.");
  let value: unknown;
  try {
    value = JSON.parse(utf8Decode(fromBase64Url(trimmed.slice(PREFIX.length))));
  } catch {
    throw new PairingCodeError("The pairing code is damaged. Copy it again from the desktop.");
  }
  const version = (value as { v?: unknown } | null)?.v;
  if (typeof version === "number" && version !== REMOTE_PROTOCOL_VERSION) {
    throw new PairingCodeError("This pairing code is from a different ZLI version. Update ZLI on both devices.");
  }
  const parsed = PairingCode.safeParse(value);
  if (!parsed.success) throw new PairingCodeError("The pairing code is damaged. Copy it again from the desktop.");
  return parsed.data;
}
