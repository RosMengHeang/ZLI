import { createCipheriv, randomBytes } from "node:crypto";
import { normalize } from "node:path";

import { describe, expect, it } from "vitest";

import { accessToken, type DroidLimitDeps, droidLimitRead, readDroidLimits } from "./droidLimits.js";

const NOW = Date.parse("2026-01-10T12:00:00.000Z");
const URL = "https://api.factory.ai/api/billing/limits";

/** Seals a login the way Droid writes auth.v2.*: base64 IV, tag, and ciphertext joined by colons. */
function seal(login: object, key: Buffer): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(login), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64")).join(":");
}

function jwt(expiresAt: number): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part({ sub: "user_1", exp: Math.floor(expiresAt / 1000) })}.sig`;
}

const limits = {
  usesTokenRateLimitsBilling: true,
  limits: {
    standard: {
      fiveHour: { usedPercent: 22, windowEnd: "2026-01-10T12:17:00.000Z", secondsRemaining: 1020 },
      weekly: { usedPercent: 41, windowEnd: "2026-01-13T10:00:00.000Z", secondsRemaining: 252000 },
      monthly: { usedPercent: 70, windowEnd: "2026-01-15T00:00:00.000Z", secondsRemaining: 388800 },
    },
    core: {
      fiveHour: { usedPercent: 0, windowEnd: null, secondsRemaining: null },
      monthly: { usedPercent: 10, windowEnd: "2026-02-01T00:00:00.000Z", secondsRemaining: 1900000 },
    },
  },
};

const standardWindows = [
  { durationMinutes: 300, usedPercent: 22, resetsAt: "2026-01-10T12:17:00.000Z" },
  { durationMinutes: 10080, usedPercent: 41, resetsAt: "2026-01-13T10:00:00.000Z" },
  { durationMinutes: 43200, usedPercent: 70, resetsAt: "2026-01-15T00:00:00.000Z" },
];

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };

function fakeDeps(options: {
  files?: Record<string, string>;
  secrets?: Record<string, string>;
  env?: NodeJS.ProcessEnv;
  reply?: (token: string | undefined) => Reply;
  refreshLogin?: (files: Map<string, string>) => void;
}) {
  const files = new Map(Object.entries(options.files ?? {}).map(([path, body]) => [normalize(path), body]));
  const calls: Array<{ url: string; token: string | undefined }> = [];
  let refreshes = 0;
  const deps: DroidLimitDeps = {
    platform: "linux",
    home: "/home/me",
    env: options.env ?? {},
    now: () => NOW,
    readFile: async (path) => {
      const file = files.get(normalize(path));
      if (file === undefined) throw new Error("ENOENT");
      return file;
    },
    keychain: async () => undefined,
    secretStore: async (service, account) => options.secrets?.[`${service}/${account}`],
    refreshLogin: async () => {
      refreshes += 1;
      options.refreshLogin?.(files);
    },
    fetch: (async (url: string, init: RequestInit = {}) => {
      const token = (init.headers as Record<string, string>).Authorization?.replace(/^Bearer /u, "");
      calls.push({ url, token });
      const reply = options.reply?.(token) ?? { body: limits };
      return new Response(JSON.stringify(reply.body ?? {}), {
        status: reply.status ?? 200,
        headers: reply.headers ?? { "content-type": "application/json" },
      });
    }) as typeof fetch,
  };
  return { deps, calls, refreshes: () => refreshes };
}

const key = randomBytes(32);
const keyFile = (token: string) => ({
  "/home/me/.factory/auth.v2.file": seal({ access_token: token, refresh_token: "refresh-1" }, key),
  "/home/me/.factory/auth.v2.key": key.toString("base64"),
});

describe("readDroidLimits", () => {
  it("reads the standard pool with the login Droid saved in auth.v2.file", async () => {
    const token = jwt(NOW + 3_600_000);
    const { deps, calls, refreshes } = fakeDeps({ files: keyFile(token) });
    expect(await readDroidLimits(deps)).toEqual({ state: "ok", windows: standardWindows });
    expect(calls).toEqual([{ url: URL, token }]);
    expect(refreshes()).toBe(0);
  });

  it("opens a login whose key Droid keeps in the OS keyring", async () => {
    const token = jwt(NOW + 3_600_000);
    const { deps, calls } = fakeDeps({
      files: { "/home/me/.factory/auth.v2.keyring": seal({ access_token: token, refresh_token: "r" }, key) },
      secrets: { "Factory CLI/auth-encryption-key": key.toString("base64") },
    });
    expect((await readDroidLimits(deps)).state).toBe("ok");
    expect(calls[0]?.token).toBe(token);
  });

  it("uses FACTORY_API_KEY over the saved login, as Droid does", async () => {
    const { deps, calls } = fakeDeps({
      files: keyFile(jwt(NOW + 3_600_000)),
      env: { FACTORY_API_KEY: "fk-123", FACTORY_API_BASE_URL: "https://factory.example/" },
    });
    expect((await readDroidLimits(deps)).state).toBe("ok");
    expect(calls).toEqual([{ url: "https://factory.example/api/billing/limits", token: "fk-123" }]);
  });

  it("has Droid renew an expired sign-in, then reads with the new token", async () => {
    const fresh = jwt(NOW + 3_600_000);
    const { deps, calls, refreshes } = fakeDeps({
      files: keyFile(jwt(NOW - 1_000)),
      refreshLogin: (files) => {
        files.set(normalize("/home/me/.factory/auth.v2.file"), keyFile(fresh)["/home/me/.factory/auth.v2.file"]);
      },
    });
    expect((await readDroidLimits(deps)).state).toBe("ok");
    expect(refreshes()).toBe(1);
    expect(calls).toEqual([{ url: URL, token: fresh }]);
  });

  it("says the sign-in needs a refresh when Droid could not renew it", async () => {
    const { deps, calls, refreshes } = fakeDeps({ files: keyFile(jwt(NOW + 30_000)) });
    expect(await readDroidLimits(deps)).toMatchObject({ state: "expired" });
    expect(refreshes()).toBe(1);
    expect(calls).toEqual([]);
  });

  it("renews once when Factory turns the token down", async () => {
    const stale = jwt(NOW + 3_600_000);
    const fresh = jwt(NOW + 7_200_000);
    const { deps, calls, refreshes } = fakeDeps({
      files: keyFile(stale),
      reply: (token) => (token === stale ? { status: 401 } : { body: limits }),
      refreshLogin: (files) => {
        files.set(normalize("/home/me/.factory/auth.v2.file"), keyFile(fresh)["/home/me/.factory/auth.v2.file"]);
      },
    });
    expect((await readDroidLimits(deps)).state).toBe("ok");
    expect(refreshes()).toBe(1);
    expect(calls.map((call) => call.token)).toEqual([stale, fresh]);
  });

  it("never asks Droid to renew an API key", async () => {
    const { deps, refreshes } = fakeDeps({ env: { FACTORY_API_KEY: "fk-123" }, reply: () => ({ status: 401 }) });
    expect(await readDroidLimits(deps)).toMatchObject({ state: "expired" });
    expect(refreshes()).toBe(0);
  });

  it("is signed out with no saved login", async () => {
    const { deps, calls } = fakeDeps({});
    expect(await readDroidLimits(deps)).toMatchObject({ state: "signed-out" });
    expect(calls).toEqual([]);
  });

  it("says when a saved login cannot be opened", async () => {
    const { deps, calls } = fakeDeps({
      files: { "/home/me/.factory/auth.v2.keyring": seal({ access_token: "t", refresh_token: "r" }, key) },
    });
    expect(await readDroidLimits(deps)).toMatchObject({ state: "unavailable" });
    expect(calls).toEqual([]);
  });

  it("waits as long as Factory asks after a 429", async () => {
    const { deps } = fakeDeps({
      env: { FACTORY_API_KEY: "fk-123" },
      reply: () => ({ status: 429, headers: { "retry-after": "3600" } }),
    });
    expect(await readDroidLimits(deps)).toMatchObject({ state: "error", retryAfterMs: 3_600_000 });
  });
});

describe("droidLimitRead", () => {
  it("has no windows for a plan without token limits", () => {
    expect(droidLimitRead({ usesTokenRateLimitsBilling: false, limits: {} })).toMatchObject({ state: "unavailable" });
  });

  it("clamps shares over 100 and leaves out a reset Factory does not give", () => {
    expect(droidLimitRead({ limits: { standard: { weekly: { usedPercent: 130, windowEnd: null } } } })).toEqual({
      state: "ok",
      windows: [{ durationMinutes: 10080, usedPercent: 100 }],
    });
  });
});

describe("accessToken", () => {
  it("returns nothing for the wrong key or a damaged file", () => {
    const sealed = seal({ access_token: "t", refresh_token: "r" }, key);
    expect(accessToken(sealed, key.toString("base64"))).toBe("t");
    expect(accessToken(sealed, randomBytes(32).toString("base64"))).toBeUndefined();
    expect(accessToken("not:sealed", key.toString("base64"))).toBeUndefined();
    expect(accessToken(sealed, "short")).toBeUndefined();
  });
});
