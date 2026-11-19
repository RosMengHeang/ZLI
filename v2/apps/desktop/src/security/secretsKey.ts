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

/**
 * Set for the runtime when the keychain was there but did not answer in time: the runtime then refuses to save
 * secrets unsealed, rather than writing them in the clear. (The runtime's SecretBox reads the same name.)
 */
export const SECRETS_KEYCHAIN_SLOW_ENV = "ZLI_SECRETS_KEYCHAIN_SLOW";

/** How long ZLI waits for the keychain before it starts without sealing, rather than never opening. */
export const KEYCHAIN_WAIT_MS = 5_000;

/**
 * The key ZLI's runtime seals secrets on disk with (the Composio key), kept at `path` encrypted by the OS keychain,
 * made on first use. No key when the OS has no keychain to seal it with. When the keychain does not answer within
 * `waitMs` (waiting on a prompt), `slow` is set and there is no key: the app still opens, and the runtime refuses to
 * save secrets until a restart rather than keeping them unsealed. A file that cannot be opened (another computer, a
 * changed account) is replaced, and the secrets sealed with the old key are asked for again.
 */
export function secretsKey(
  path: string,
  codec: KeychainCodec,
  waitMs = KEYCHAIN_WAIT_MS,
): Promise<{ key?: string; slow?: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gaveUp = new Promise<{ slow: true }>((resolve) => {
    timer = setTimeout(() => resolve({ slow: true }), waitMs);
  });
  const found = keyFrom(path, codec).then((key): { key?: string; slow?: true } =>
    key === UNSEALABLE ? { slow: true } : key ? { key } : {},
  );
  return Promise.race([found, gaveUp]).finally(() => clearTimeout(timer));
}

/**
 * The keychain is there but would not seal a new key (a denied prompt, a locked keychain, a file that cannot be
 * written). Treated like a slow keychain: the runtime refuses to save secrets rather than keeping them unsealed.
 */
const UNSEALABLE = Symbol("unsealable");

async function keyFrom(path: string, codec: KeychainCodec): Promise<string | typeof UNSEALABLE | undefined> {
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
    return UNSEALABLE;
  }
  return key;
}
