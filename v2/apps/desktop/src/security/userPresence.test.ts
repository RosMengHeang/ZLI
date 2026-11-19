import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { type KeychainCodec, protectWithKeychain, protectWithPresence, secretsKey } from "./secretsKey.js";
import type { UserPresence } from "./userPresence.js";
import { windowsHello } from "./windowsHello.js";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function keyPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "zli-presence-"));
  folders.push(dir);
  return join(dir, "secrets-key.bin");
}

const keychain: KeychainCodec = {
  available: async () => true,
  encrypt: async (text) => Buffer.from(text, "utf8").reverse(),
  decrypt: async (sealed) => Buffer.from(sealed).reverse().toString("utf8"),
};

/** A stand-in for Hello: a deterministic "signature" made from a device secret, or a cancel. */
function hello(options: { cancel?: boolean; available?: boolean; device?: string } = {}) {
  const stub = {
    asked: 0,
    available: async () => options.available ?? true,
    secret: async (challenge: Buffer) => {
      stub.asked += 1;
      if (options.cancel) return undefined;
      return createHmac("sha256", options.device ?? "device").update(challenge).digest();
    },
  };
  return stub;
}

async function freshKey(path: string): Promise<string> {
  const { key } = await secretsKey(path, keychain);
  if (!key) throw new Error("no key");
  return key;
}

describe("unlocking connected apps with user presence", () => {
  it("rewraps the key behind the check, so the keychain alone no longer opens it", async () => {
    const path = keyPath();
    const key = await freshKey(path);
    expect(await protectWithPresence(path, key, hello())).toBe(true);
    // A process that can only ask the keychain (DPAPI) gets nothing it can use.
    expect(await keychain.decrypt(readFileSync(path))).not.toContain(key);
    expect(readFileSync(path).toString("latin1")).not.toContain(key);
    expect(await secretsKey(path, keychain)).toEqual({ locked: true, presence: true });
  });

  it("opens with the same key on the next launch, asking once", async () => {
    const path = keyPath();
    const key = await freshKey(path);
    await protectWithPresence(path, key, hello());
    const check = hello();
    expect(await secretsKey(path, keychain, undefined, check)).toEqual({ key, presence: true });
    expect(check.asked).toBe(1);
  });

  it("stays locked when the user cancels, and keeps the file so the sealed secrets survive", async () => {
    const path = keyPath();
    const key = await freshKey(path);
    await protectWithPresence(path, key, hello());
    const before = readFileSync(path);
    expect(await secretsKey(path, keychain, undefined, hello({ cancel: true }))).toEqual({
      locked: true,
      presence: true,
    });
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it("stays locked when a different credential answers", async () => {
    const path = keyPath();
    const key = await freshKey(path);
    await protectWithPresence(path, key, hello());
    expect((await secretsKey(path, keychain, undefined, hello({ device: "other" }))).locked).toBe(true);
  });

  it("leaves the keychain file alone when Hello is not set up or the user cancels turning it on", async () => {
    const path = keyPath();
    const key = await freshKey(path);
    const before = readFileSync(path);
    expect(await protectWithPresence(path, key, hello({ available: false }))).toBe(false);
    expect(await protectWithPresence(path, key, hello({ cancel: true }))).toBe(false);
    expect(readFileSync(path).equals(before)).toBe(true);
    expect((await secretsKey(path, keychain)).key).toBe(key);
  });

  it("refuses to turn on when the check does not give the same secret twice", async () => {
    const path = keyPath();
    const key = await freshKey(path);
    let n = 0;
    const flaky: UserPresence = { available: async () => true, secret: async () => Buffer.alloc(32, n++) };
    expect(await protectWithPresence(path, key, flaky)).toBe(false);
    expect((await secretsKey(path, keychain)).key).toBe(key);
  });

  it("turning it off rewraps with the keychain, and the same key comes back without a prompt", async () => {
    const path = keyPath();
    const key = await freshKey(path);
    await protectWithPresence(path, key, hello());
    expect(await protectWithKeychain(path, key, keychain)).toBe(true);
    const check = hello();
    expect(await secretsKey(path, keychain, undefined, check)).toEqual({ key });
    expect(check.asked).toBe(0);
  });

  it("never replaces a presence file with a new key, even with no check on this launch", async () => {
    const path = keyPath();
    writeFileSync(path, Buffer.concat([Buffer.from("ZLIP1\n", "latin1"), Buffer.alloc(80, 1)]));
    const before = readFileSync(path);
    expect(await secretsKey(path, keychain)).toEqual({ locked: true, presence: true });
    expect(readFileSync(path).equals(before)).toBe(true);
  });
});

describe("windowsHello", () => {
  it("passes the challenge on stdin and hashes the signature into a fixed-size secret", async () => {
    const run = vi.fn(async (mode: "check" | "sign", _input: string) =>
      mode === "check" ? "available" : `ok:${Buffer.from("signature").toString("base64")}`,
    );
    const presence = windowsHello(run);
    expect(await presence.available()).toBe(true);
    const challenge = Buffer.alloc(32, 7);
    const first = await presence.secret(challenge);
    expect(first).toHaveLength(32);
    expect(await presence.secret(challenge)).toEqual(first);
    expect(run).toHaveBeenCalledWith("sign", challenge.toString("base64"));
  });

  it("reads cancelled, unavailable and a failed run as no secret", async () => {
    expect(await windowsHello(async () => "unavailable").available()).toBe(false);
    expect(await windowsHello(async () => "cancelled").secret(Buffer.alloc(32))).toBeUndefined();
    const broken = windowsHello(async () => {
      throw new Error("powershell.exe not found");
    });
    expect(await broken.available()).toBe(false);
    expect(await broken.secret(Buffer.alloc(32))).toBeUndefined();
  });
});
