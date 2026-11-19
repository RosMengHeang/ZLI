import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

/** The environment variable the runtime reads its sealing key from (the runtime's SecretBox reads the same name). */
export const SECRETS_KEY_ENV = "ZLI_SECRETS_KEY";

/** What seals and opens the key: Electron's safeStorage (DPAPI on Windows, the Keychain on macOS, libsecret on Linux). */
export type KeychainCodec = {
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(sealed: Buffer): string;
};

/**
 * The key ZLI's runtime seals secrets on disk with (the Composio key), kept at `path` encrypted by the OS keychain,
 * made on first use. Undefined when the OS has no keychain to seal it with: the
 * runtime then keeps those files as before. A file that cannot be opened (another computer, a changed account) is
 * replaced, and the secrets sealed with the old key are asked for again.
 */
export function secretsKey(path: string, codec: KeychainCodec): string | undefined {
  if (!codec.available()) return undefined;
  try {
    const key = codec.decrypt(readFileSync(path));
    if (Buffer.from(key, "base64").length === 32) return key;
  } catch {
    // Missing, or sealed somewhere else: a new one is made below.
  }
  const key = randomBytes(32).toString("base64");
  try {
    writeFileSync(path, codec.encrypt(key), { mode: 0o600 });
  } catch {
    return undefined;
  }
  return key;
}
