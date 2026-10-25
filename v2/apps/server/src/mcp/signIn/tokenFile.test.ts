import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { McpSignIns } from "./McpSignIns.js";
import type { FetchLike } from "./oauth.js";
import { freshAccessToken, markSignInExpired, readSignIn, type StoredSignIn, writeSignIn } from "./tokenFile.js";

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

const SERVER = "https://mcp.example.com/mcp";
const NOW = 5_000_000;

async function savedLogin(overrides: Partial<StoredSignIn> = {}): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "zli-token-"));
  temps.push(dir);
  const signIns = new McpSignIns({ dir });
  const path = signIns.tokenFile(SERVER);
  await writeSignIn(path, {
    version: 1,
    serverUrl: SERVER,
    via: "browser",
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: NOW - 1,
    account: "ada",
    signedInAt: "2025-01-01T00:00:00.000Z",
    refresh: {
      tokenEndpoint: "https://auth.example.com/token",
      clientId: "client-1",
      auth: "none",
      resource: SERVER,
    },
    ...overrides,
  });
  return { dir, path };
}

function tokenServer(answer: () => Response): { fetch: FetchLike; calls: () => number } {
  let calls = 0;
  return {
    fetch: (async () => {
      calls += 1;
      return answer();
    }) as FetchLike,
    calls: () => calls,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("login expiry", () => {
  it("marks the login expired when the server turns the refresh token down", async () => {
    const { dir, path } = await savedLogin();
    const server = tokenServer(() => json({ error: "invalid_grant", error_description: "Token revoked" }, 400));
    expect(await freshAccessToken(path, { fetch: server.fetch, now: () => NOW })).toBeUndefined();
    expect(await readSignIn(path)).toMatchObject({ accessToken: "access-1", expiredAt: new Date(NOW).toISOString() });

    // An expired login gives no token until forced, so agents do not keep sending a dead one.
    expect(await freshAccessToken(path, { fetch: server.fetch, now: () => NOW })).toBeUndefined();
    expect(server.calls()).toBe(1);

    const signIns = new McpSignIns({ dir, now: () => NOW });
    await signIns.load();
    expect(signIns.status(SERVER)).toEqual({ signedIn: false, expired: true, via: "browser", account: "ada" });
    expect(signIns.accessToken(SERVER)).toBeUndefined();
  });

  it("keeps the login on network trouble, and clears the mark after a refresh works", async () => {
    const { path } = await savedLogin();
    const down = tokenServer(() => json({ error: "temporarily_unavailable" }, 503));
    expect(await freshAccessToken(path, { fetch: down.fetch, now: () => NOW })).toBe("access-1");
    expect((await readSignIn(path))?.expiredAt).toBeUndefined();

    await markSignInExpired(path, "access-1", { now: () => NOW });
    expect((await readSignIn(path))?.expiredAt).toBeDefined();
    const up = tokenServer(() => json({ access_token: "access-2", expires_in: 3600 }));
    expect(await freshAccessToken(path, { force: true, fetch: up.fetch, now: () => NOW })).toBe("access-2");
    const saved = await readSignIn(path);
    expect(saved).toMatchObject({ accessToken: "access-2" });
    expect(saved?.expiredAt).toBeUndefined();
  });

  it("only marks the token that was turned down", async () => {
    const { path } = await savedLogin({ expiresAt: NOW + 3_600_000 });
    await markSignInExpired(path, "some-older-token", { now: () => NOW });
    expect((await readSignIn(path))?.expiredAt).toBeUndefined();
    await markSignInExpired(path, "access-1", { now: () => NOW });
    expect((await readSignIn(path))?.expiredAt).toBe(new Date(NOW).toISOString());
  });
});
