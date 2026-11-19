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
  available: () => available,
  encrypt: (text) => Buffer.from(text, "utf8").reverse(),
  decrypt: (sealed) => Buffer.from(sealed).reverse().toString("utf8"),
});

describe("secretsKey", () => {
  it("makes a key once, keeps it sealed by the keychain, and gives the same one back", () => {
    const dir = mkdtempSync(join(tmpdir(), "zli-key-"));
    folders.push(dir);
    const path = join(dir, "secrets-key.bin");
    const key = secretsKey(path, keychain());
    expect(Buffer.from(key ?? "", "base64")).toHaveLength(32);
    expect(readFileSync(path, "utf8")).not.toContain(key);
    expect(secretsKey(path, keychain())).toBe(key);
  });

  it("gives no key without a keychain, so nothing is sealed with a key kept in the clear", () => {
    const dir = mkdtempSync(join(tmpdir(), "zli-key-"));
    folders.push(dir);
    expect(secretsKey(join(dir, "secrets-key.bin"), keychain(false))).toBeUndefined();
  });
});
