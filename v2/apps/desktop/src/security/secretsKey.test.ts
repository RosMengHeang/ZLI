import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { handOffKey, type KeychainCodec, removeHandoffs, secretsKey } from "./secretsKey.js";

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
    const { key } = await secretsKey(path, keychain());
    expect(Buffer.from(key ?? "", "base64")).toHaveLength(32);
    expect(readFileSync(path, "utf8")).not.toContain(key);
    expect((await secretsKey(path, keychain())).key).toBe(key);
  });

  it("gives no key without a keychain, so nothing is sealed with a key kept in the clear", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zli-key-"));
    folders.push(dir);
    expect(await secretsKey(join(dir, "secrets-key.bin"), keychain(false))).toEqual({ noKeychain: true });
  });

  it("says the keychain was slow when it never answers, so the app opens and the runtime stays careful", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zli-key-"));
    folders.push(dir);
    const stuck: KeychainCodec = {
      available: () => new Promise(() => undefined),
      encrypt: () => new Promise(() => undefined),
      decrypt: () => new Promise(() => undefined),
    };
    expect(await secretsKey(join(dir, "secrets-key.bin"), stuck, 20)).toEqual({ slow: true });
  });

  it("never lets the runtime save unsealed when the keychain is there but will not seal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zli-key-"));
    folders.push(dir);
    const refusing: KeychainCodec = {
      available: async () => true,
      encrypt: async () => {
        throw new Error("The user denied access to the keychain.");
      },
      decrypt: async () => {
        throw new Error("The user denied access to the keychain.");
      },
    };
    expect(await secretsKey(join(dir, "secrets-key.bin"), refusing)).toEqual({ slow: true });
  });

  it("treats Linux's basic_text store as no keychain, since its password is built into Chromium", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zli-key-"));
    folders.push(dir);
    const path = join(dir, "secrets-key.bin");
    expect(await secretsKey(path, { ...keychain(), weak: () => true })).toEqual({ noKeychain: true });
    expect(() => readFileSync(path)).toThrow();
  });

  it("hands the key over in a new file each start, never in the environment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zli-key-"));
    folders.push(dir);
    const first = handOffKey(dir, "k1");
    const second = handOffKey(dir, "k2");
    expect(first).not.toBe(second);
    expect(readFileSync(first, "utf8")).toBe("k1");
  });

  it("deletes handoff files no server read, and leaves the sealed key alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "zli-key-"));
    folders.push(dir);
    writeFileSync(join(dir, "secrets-key.bin"), "sealed");
    writeFileSync(join(dir, "runtime.sqlite"), "");
    handOffKey(dir, "k1");
    handOffKey(dir, "k2");
    removeHandoffs(dir);
    expect(readdirSync(dir).sort()).toEqual(["runtime.sqlite", "secrets-key.bin"]);
    removeHandoffs(join(dir, "missing"));
  });
});
