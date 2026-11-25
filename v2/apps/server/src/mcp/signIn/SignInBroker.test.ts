import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SecretBox } from "../../secrets/SecretBox.js";
import { McpSignIns } from "./McpSignIns.js";
import {
  parseSignInGrant,
  reportRejectedToken,
  requestAccessToken,
  SignInBroker,
  signInEnvName,
} from "./SignInBroker.js";
import { readSignIn, type StoredSignIn, sealSignIns, writeSignIn } from "./tokenFile.js";

const brokers: SignInBroker[] = [];
const temps: string[] = [];
afterEach(async () => {
  sealSignIns(undefined);
  for (const broker of brokers.splice(0)) await broker.stop();
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

const LOGIN: StoredSignIn = {
  version: 1,
  serverUrl: "https://mcp.example.com/mcp",
  via: "browser",
  accessToken: "access-1",
  refreshToken: "refresh-1",
  signedInAt: "2026-11-25T00:00:00.000Z",
};

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zli-broker-"));
  temps.push(dir);
  return dir;
}

async function started(options: ConstructorParameters<typeof SignInBroker>[0] = {}): Promise<SignInBroker> {
  const broker = new SignInBroker(options);
  brokers.push(broker);
  await broker.start();
  return broker;
}

describe("sealed logins", () => {
  it("saves a login as sealed text when a key is set, and reads it back", async () => {
    sealSignIns(SecretBox.withKey(randomBytes(32)));
    const path = join(await tempDir(), "login.json");
    await writeSignIn(path, LOGIN);
    const text = await readFile(path, "utf8");
    expect(SecretBox.isSealed(text)).toBe(true);
    expect(text).not.toContain("refresh-1");
    expect(await readSignIn(path)).toEqual(LOGIN);
  });

  it("reads nothing from a sealed login without the key", async () => {
    sealSignIns(SecretBox.withKey(randomBytes(32)));
    const path = join(await tempDir(), "login.json");
    await writeSignIn(path, LOGIN);
    sealSignIns(SecretBox.withKey(randomBytes(32)));
    expect(await readSignIn(path)).toBeUndefined();
    sealSignIns(undefined);
    expect(await readSignIn(path)).toBeUndefined();
  });

  it("seals a login saved before sealing when the logins load", async () => {
    const dir = await tempDir();
    const signIns = new McpSignIns({ dir });
    const path = signIns.tokenFile(LOGIN.serverUrl);
    await writeFile(path, JSON.stringify(LOGIN));
    sealSignIns(SecretBox.withKey(randomBytes(32)));
    await signIns.load();
    expect(SecretBox.isSealed(await readFile(path, "utf8"))).toBe(true);
    expect(signIns.accessToken(LOGIN.serverUrl)).toBe("access-1");
  });
});

describe("SignInBroker", () => {
  it("hands a bridge with the right key a fresh access token for its login only", async () => {
    const asked: Array<{ file: string; force: boolean }> = [];
    const broker = await started({
      fresh: async (file, options) => {
        asked.push({ file, force: options?.force === true });
        return `token-for-${file}`;
      },
    });
    const grant = broker.grant("/logins/a.json");
    expect(grant).toBeDefined();
    if (!grant) return;
    expect(broker.grant("/logins/a.json")).toEqual(grant);
    expect(await requestAccessToken(grant, false)).toBe("token-for-/logins/a.json");
    expect(await requestAccessToken(grant, true)).toBe("token-for-/logins/a.json");
    expect(asked).toEqual([
      { file: "/logins/a.json", force: false },
      { file: "/logins/a.json", force: true },
    ]);
  });

  it("turns away a wrong key, a browser page, and anything but POST", async () => {
    const broker = await started({ fresh: async () => "secret" });
    const grant = broker.grant("/logins/a.json");
    if (!grant) throw new Error("no grant");
    await expect(requestAccessToken({ ...grant, token: "wrong" }, false)).rejects.toThrow("401");
    const fromPage = await fetch(grant.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${grant.token}`, Origin: "https://evil.example" },
      body: "{}",
    });
    expect(fromPage.status).toBe(404);
    const get = await fetch(grant.url, { headers: { Authorization: `Bearer ${grant.token}` } });
    expect(get.status).toBe(405);
  });

  it("marks the login expired when a bridge reports a turned-down token", async () => {
    const expired: Array<{ file: string; token: string }> = [];
    const broker = await started({ expire: async (file, token) => void expired.push({ file, token }) });
    const grant = broker.grant("/logins/a.json");
    if (!grant) throw new Error("no grant");
    await reportRejectedToken(grant, "access-1");
    expect(expired).toEqual([{ file: "/logins/a.json", token: "access-1" }]);
  });

  it("gives no grant before it starts", () => {
    expect(new SignInBroker().grant("/logins/a.json")).toBeUndefined();
  });
});

describe("grants", () => {
  it("accept only a loopback http address with a key", () => {
    expect(parseSignInGrant(JSON.stringify({ url: "http://127.0.0.1:4000/sign-in", token: "k" }))).toEqual({
      url: "http://127.0.0.1:4000/sign-in",
      token: "k",
    });
    expect(parseSignInGrant(JSON.stringify({ url: "https://evil.example/sign-in", token: "k" }))).toBeUndefined();
    expect(parseSignInGrant(JSON.stringify({ url: "http://127.0.0.1:4000/sign-in", token: "" }))).toBeUndefined();
    expect(parseSignInGrant("not json")).toBeUndefined();
    expect(parseSignInGrant(undefined)).toBeUndefined();
  });

  it("name an environment variable per login file", () => {
    expect(signInEnvName("/dir/0123abcd.json")).toBe("ZLI_CONNECT_SIGN_IN_0123abcd");
  });
});
