import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

/** The environment variable the runtime reads its sealing key from (the runtime's SecretBox reads the same name). */
export const SECRETS_KEY_ENV = "ZLI_SECRETS_KEY";

/** What seals and opens the key: Electron's safeStorage (DPAPI on Windows, the Keychain on macOS, libsecret on Linux). */
export type KeychainCodec = {
  available(): Promise<boolean>;
  encrypt(text: string): Promise<Buffer>;
  decrypt(sealed: Buffer): Promise<string>;
};

/** How long ZLI waits for the keychain before it starts without sealing, rather than never opening. */
export const KEYCHAIN_WAIT_MS = 5_000;

/**
 * The key ZLI's runtime seals secrets on disk with (the Composio key), kept at `path` encrypted by the OS keychain,
 * made on first use. Undefined when the OS has no keychain to seal it with, or it does not answer within `waitMs`
 * (a keychain waiting on a prompt, or none for this account): the runtime then starts without sealing instead of
 * the app never opening. A file that cannot be opened (another computer, a changed account) is replaced, and the
 * secrets sealed with the old key are asked for again.
 */
export function secretsKey(path: string, codec: KeychainCodec, waitMs = KEYCHAIN_WAIT_MS): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gaveUp = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), waitMs);
  });
  return Promise.race([keyFrom(path, codec), gaveUp]).finally(() => clearTimeout(timer));
}

async function keyFrom(path: string, codec: KeychainCodec): Promise<string | undefined> {
  if (!(await codec.available().catch(() => false))) return undefined;
  try {
    const key = await codec.decrypt(await readFile(path));
    if (Buffer.from(key, "base64").length === 32) return key;
  } catch {
    // Missing, or sealed somewhere else: a new one is made below.
  }
  const key = randomBytes(32).toString("base64");
  try {
    await writeFile(path, await codec.encrypt(key), { mode: 0o600 });
  } catch {
    return undefined;
  }
  return key;
}
