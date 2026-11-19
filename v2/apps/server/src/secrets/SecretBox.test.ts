import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConnectedApps } from "../mcp/ConnectedApps.js";
import { SECRETS_KEY_ENV, SECRETS_KEYCHAIN_SLOW_ENV, SecretBox } from "./SecretBox.js";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "zli-secrets-"));
  folders.push(dir);
  return dir;
}

describe("SecretBox", () => {
  it("seals and opens, and refuses another key or a changed seal", () => {
    const box = SecretBox.withKey(randomBytes(32));
    const sealed = box.seal("ck_secret");
    expect(sealed).toMatch(/^sealed:v1:/u);
    expect(sealed).not.toContain("ck_secret");
    expect(box.open(sealed)).toBe("ck_secret");
    expect(box.seal("ck_secret")).not.toBe(sealed);
    expect(SecretBox.withKey(randomBytes(32)).open(sealed)).toBeUndefined();
    expect(box.open(`${sealed.slice(0, -4)}AAAA`)).toBeUndefined();
    expect(box.open("ck_plain")).toBeUndefined();
  });

  it("takes its key out of the environment, so no agent started later inherits it", () => {
    const env: NodeJS.ProcessEnv = { [SECRETS_KEY_ENV]: randomBytes(32).toString("base64"), OTHER: "1" };
    expect(SecretBox.fromEnvironment(env)).toBeInstanceOf(SecretBox);
    expect(env).toEqual({ OTHER: "1" });
    expect(SecretBox.fromEnvironment({})).toBeUndefined();
    expect(SecretBox.fromEnvironment({ [SECRETS_KEY_ENV]: "short" })).toBeUndefined();
  });

  it("keeps the Composio key sealed on disk, seals an old plain one, and says when one cannot be opened", async () => {
    const dir = folder();
    const path = join(dir, "connected-apps.json");
    const box = SecretBox.withKey(randomBytes(32));
    // A key saved before sealing: read, then sealed in place.
    writeFileSync(path, JSON.stringify({ via: "connect", apiKey: "ck_old_plain" }));
    const apps = new ConnectedApps({ path, box });
    await apps.load();
    expect(apps.upstream()?.headers).toEqual({ "x-consumer-api-key": "ck_old_plain" });
    const onDisk = readFileSync(path, "utf8");
    expect(onDisk).not.toContain("ck_old_plain");
    expect(JSON.parse(onDisk).apiKey).toMatch(/^sealed:v1:/u);
    // Read back with the same key.
    const again = new ConnectedApps({ path, box });
    await again.load();
    expect(again.upstream()?.headers).toEqual({ "x-consumer-api-key": "ck_old_plain" });
    // Another key (another computer, a reset keychain): nothing is used, and the person is told to paste it again.
    const elsewhere = new ConnectedApps({ path, box: SecretBox.withKey(randomBytes(32)) });
    await elsewhere.load();
    expect(elsewhere.upstream()).toBeUndefined();
    expect(await elsewhere.status()).toMatchObject({ configured: false, problem: expect.stringContaining("Paste it") });
  });

  it("never saves the key unsealed when the keychain was there but slow to answer", async () => {
    const env: NodeJS.ProcessEnv = { [SECRETS_KEYCHAIN_SLOW_ENV]: "1" };
    expect(SecretBox.keychainSlow(env)).toBe(true);
    expect(env).toEqual({});
    const path = join(folder(), "connected-apps.json");
    const apps = new ConnectedApps({ path, keychainSlow: true });
    await apps.load();
    await expect(apps.setKey("ck_new")).rejects.toThrow(/Restart ZLI/u);
    expect(() => readFileSync(path, "utf8")).toThrow();
    expect(await apps.status()).toMatchObject({ configured: false, problem: expect.stringContaining("Restart ZLI") });
  });
});
