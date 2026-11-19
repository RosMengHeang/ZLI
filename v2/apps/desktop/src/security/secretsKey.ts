import { randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isPresenceSealed, openWithPresence, sealWithPresence, type UserPresence } from "./userPresence.js";

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

export type SealingResult = {
  key?: string;
  slow?: true;
  noKeychain?: true;
  /** The key file needs the presence check and the user cancelled it, or it is not set up here any more. */
  locked?: true;
  /** The key file is wrapped by the presence check rather than the keychain alone. */
  presence?: true;
};

/**
 * The key ZLI's runtime seals secrets on disk with (the Composio key), kept at `path` encrypted by the OS keychain,
 * made on first use. No key when the OS has no keychain to seal it with. When the keychain does not answer within
 * `waitMs` (waiting on a prompt), `slow` is set and there is no key: the app still opens, and the runtime refuses to
 * save secrets until a restart rather than keeping them unsealed. A file that cannot be opened (another computer, a
 * changed account) is replaced, and the secrets sealed with the old key are asked for again.
 *
 * A file wrapped by the presence check (see userPresence.ts) is opened with `presence`, with no time limit since the
 * user is answering a prompt. If they cancel it is `locked`: never replaced, so the sealed secrets survive until the
 * next launch.
 */
export async function secretsKey(
  path: string,
  codec: KeychainCodec,
  waitMs = KEYCHAIN_WAIT_MS,
  presence?: UserPresence,
): Promise<SealingResult> {
  const file = await readFile(path).catch(() => undefined);
  if (file && isPresenceSealed(file)) {
    const key = presence ? await openWithPresence(file, presence).catch(() => undefined) : undefined;
    return key && Buffer.from(key, "base64").length === 32 ? { key, presence: true } : { locked: true, presence: true };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gaveUp = new Promise<{ slow: true }>((resolve) => {
    timer = setTimeout(() => resolve({ slow: true }), waitMs);
  });
  const found = keyFrom(path, codec).then(
    (key): SealingResult => (key === UNSEALABLE ? { slow: true } : key ? { key } : { noKeychain: true }),
  );
  return Promise.race([found, gaveUp]).finally(() => clearTimeout(timer));
}

/**
 * Turns the setting on: rewraps the running key behind the presence check. Written to a new file first and moved
 * over the old one, so a failed write never leaves the key unreadable. False when the user cancels.
 */
export async function protectWithPresence(path: string, key: string, presence: UserPresence): Promise<boolean> {
  if (!(await presence.available().catch(() => false))) return false;
  const sealed = await sealWithPresence(key, presence).catch(() => undefined);
  if (!sealed) return false;
  // Checked before it replaces the old file: a credential that signs differently each time would lock the key out.
  if ((await openWithPresence(sealed, presence).catch(() => undefined)) !== key) return false;
  await replaceFile(path, sealed);
  return true;
}

/** Turns the setting off: rewraps the running key with the keychain alone, as before. */
export async function protectWithKeychain(path: string, key: string, codec: KeychainCodec): Promise<boolean> {
  const sealed = await codec.encrypt(key).catch(() => undefined);
  if (!sealed) return false;
  await replaceFile(path, sealed);
  return true;
}

async function replaceFile(path: string, contents: Buffer): Promise<void> {
  const next = `${path}.${randomBytes(6).toString("hex")}.next`;
  await writeFile(next, contents, { mode: 0o600, flag: "wx" });
  await rename(next, path);
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
    // Known limit: the keychain unwraps this for any process running as the same OS user (DPAPI on Windows), a buddy's
    // shell included. Turning on the presence check (protectWithPresence) closes that for the file on disk.
    await writeFile(path, await codec.encrypt(key), { mode: 0o600 });
  } catch {
    return UNSEALABLE;
  }
  return key;
}
