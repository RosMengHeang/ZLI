import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The environment variable the runtime reads its sealing key from (the runtime's SecretBox reads the same name). */
export const SECRETS_KEY_ENV = "ZLI_SECRETS_KEY";

/** What seals and opens the key: Electron's safeStorage (DPAPI on Windows, the Keychain on macOS, libsecret on Linux). */
export type KeychainCodec = {
  available(): Promise<boolean>;
  /**
   * True when the keychain only pretends to seal: on Linux without a secret service, Electron falls back to
   * `basic_text`, a password written into Chromium itself. That counts as no keychain.
   */
  weak?(): boolean;
  encrypt(text: string): Promise<Buffer>;
  decrypt(sealed: Buffer): Promise<string>;
};

/**
 * Set for the runtime when the keychain was there but did not answer in time: the runtime then refuses to save
 * secrets unsealed, rather than writing them in the clear. (The runtime's SecretBox reads the same name.)
 */
export const SECRETS_KEYCHAIN_SLOW_ENV = "ZLI_SECRETS_KEYCHAIN_SLOW";

/** Set for the runtime when there is no real keychain, so it can say the Composio key is saved unencrypted. */
export const SECRETS_NO_KEYCHAIN_ENV = "ZLI_SECRETS_NO_KEYCHAIN";

/**
 * Where the runtime finds the key. The key itself never goes in the environment: on Linux and macOS a process's
 * starting environment stays readable (/proc/<pid>/environ, ps eww) after it deletes the variable. The runtime
 * reads the file once and deletes it before any agent starts. (The runtime's SecretBox reads the same name.)
 */
export const SECRETS_KEY_FILE_ENV = "ZLI_SECRETS_KEY_FILE";

/** Writes the key to a new file only this account can read, for the runtime to pick up; returns its path. */
export async function handOffKey(dir: string, key: string): Promise<string> {
  const path = join(dir, `secrets-key.${randomBytes(12).toString("hex")}.handoff`);
  await writeFile(path, key, { mode: 0o600, flag: "wx" });
  return path;
}

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
): Promise<{ key?: string; slow?: true; noKeychain?: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gaveUp = new Promise<{ slow: true }>((resolve) => {
    timer = setTimeout(() => resolve({ slow: true }), waitMs);
  });
  const found = keyFrom(path, codec).then((key): { key?: string; slow?: true; noKeychain?: true } =>
    key === UNSEALABLE ? { slow: true } : key ? { key } : { noKeychain: true },
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
  if (codec.weak?.()) return undefined;
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
