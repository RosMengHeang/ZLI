import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type KeychainCodec, secretsKey } from "./secretsKey.js";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A stand-in keychain: reverses the bytes, so the file never holds the key as written. */
const keychain = (available = true): KeychainCodec => ({
  available: async () => available,
  encrypt: async (text) => Buffer.from(text, "utf8").reverse(),
  decrypt: async (sealed) => Buffer.from(sealed).reverse().toString("utf8"),
});

describe("secretsKey", () => {
  it("makes a key once, keeps it sealed by the keychain, and gives the same one back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zli-key-"));
    folders.push(dir);
    const path = join(dir, "secrets-key.bin");
    const key = await secretsKey(path, keychain());
    expect(Buffer.from(key ?? "", "base64")).toHaveLength(32);
    expect(readFileSync(path, "utf8")).not.toContain(key);
    expect(await secretsKey(path, keychain())).toBe(key);
  });

  it("gives no key without a keychain, so nothing is sealed with a key kept in the clear", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zli-key-"));
    folders.push(dir);
    expect(await secretsKey(join(dir, "secrets-key.bin"), keychain(false))).toBeUndefined();
  });

  it("starts without a key when the keychain never answers, so the app still opens", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zli-key-"));
    folders.push(dir);
    const stuck: KeychainCodec = {
      available: () => new Promise(() => undefined),
      encrypt: () => new Promise(() => undefined),
      decrypt: () => new Promise(() => undefined),
    };
    expect(await secretsKey(join(dir, "secrets-key.bin"), stuck, 20)).toBeUndefined();
  });
});
