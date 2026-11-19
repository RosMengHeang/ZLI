import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * A check that the person at the computer is there (Windows Hello, Touch ID), used to wrap `secrets-key.bin` so the
 * keychain alone cannot open it.
 *
 * What this stops: another process running as the same user (a buddy's shell, say) reading the file and unwrapping it
 * with DPAPI without anyone noticing. What it does not stop: once ZLI has unlocked the key it sits in this process's
 * memory, and a debugger running as the same user can still read it from there. It also cannot stop that process
 * asking Hello itself; it can only make the user see a prompt they did not expect.
 */
export type UserPresence = {
  /** Whether the check is set up on this computer (a Hello PIN or fingerprint, Touch ID). */
  available(): Promise<boolean>;
  /**
   * Bytes that only come back after the user passes the check, the same bytes for the same challenge every time.
   * Undefined when they cancel or the check fails.
   */
  secret(challenge: Buffer): Promise<Buffer | undefined>;
};

/** Marks a key file wrapped by a presence check rather than by the keychain alone. */
const MAGIC = Buffer.from("ZLIP1\n", "latin1");
const CHALLENGE_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function isPresenceSealed(file: Buffer): boolean {
  return file.length > MAGIC.length && file.subarray(0, MAGIC.length).equals(MAGIC);
}

function wrappingKey(secret: Buffer, challenge: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, challenge, "zli secrets-key wrap v1", 32));
}

/** Wraps `key` (base64) behind the presence check; the file holds a fresh challenge and the AES-GCM sealed key. */
export async function sealWithPresence(key: string, presence: UserPresence): Promise<Buffer | undefined> {
  const challenge = randomBytes(CHALLENGE_BYTES);
  const secret = await presence.secret(challenge);
  if (!secret) return undefined;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", wrappingKey(secret, challenge), iv);
  const sealed = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
  return Buffer.concat([MAGIC, challenge, iv, cipher.getAuthTag(), sealed]);
}

/** The key inside a presence-sealed file, or undefined when the user cancels or the secret does not match. */
export async function openWithPresence(file: Buffer, presence: UserPresence): Promise<string | undefined> {
  let at = MAGIC.length;
  const challenge = file.subarray(at, (at += CHALLENGE_BYTES));
  const iv = file.subarray(at, (at += IV_BYTES));
  const tag = file.subarray(at, (at += TAG_BYTES));
  const sealed = file.subarray(at);
  const secret = await presence.secret(Buffer.from(challenge));
  if (!secret) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", wrappingKey(secret, challenge), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(sealed), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}
