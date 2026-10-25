import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { McpSignIns, normalizeServerUrl } from "./McpSignIns.js";
import type { FetchLike } from "./oauth.js";
import { freshAccessToken, readSignIn } from "./tokenFile.js";

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zli-signin-"));
  temps.push(dir);
  return dir;
}

const SERVER = "https://mcp.example.com/mcp";

type Seen = { registrations: unknown[]; tokenBodies: URLSearchParams[] };

/** A fake MCP server and authorization server. Loopback requests go to the real network. */
function fakeFetch(seen: Seen, options: { register?: boolean } = {}): FetchLike {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("http://localhost:")) return fetch(url, init);
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
    if (url === SERVER) {
      return json({}, 401, {
        "www-authenticate":
          'Bearer realm="OAuth", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="read"',
      });
    }
    if (url === "https://mcp.example.com/.well-known/oauth-protected-resource/mcp") {
      return json({
        resource: SERVER,
        authorization_servers: ["https://auth.example.com"],
        scopes_supported: ["read"],
      });
    }
    if (url === "https://auth.example.com/.well-known/oauth-authorization-server") {
      return json({
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        ...(options.register === false ? {} : { registration_endpoint: "https://auth.example.com/register" }),
        token_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
        scopes_supported: ["read", "offline_access"],
      });
    }
    if (url === "https://auth.example.com/register") {
      seen.registrations.push(JSON.parse(String(init?.body)));
      return json({ client_id: "client-1", token_endpoint_auth_method: "none" }, 201);
    }
    if (url === "https://auth.example.com/token") {
      const body = new URLSearchParams(String(init?.body));
      seen.tokenBodies.push(body);
      if (body.get("grant_type") === "refresh_token") return json({ access_token: "access-2", expires_in: 3600 });
      if (body.get("code") !== "good-code") return json({ error: "invalid_grant" }, 400);
      return json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, token_type: "Bearer" });
    }
    return new Response("not found", { status: 404 });
  }) as FetchLike;
}

async function browserReturns(url: string, params: Record<string, string>): Promise<Response> {
  const authorize = new URL(url);
  const redirect = new URL(authorize.searchParams.get("redirect_uri") ?? "");
  for (const [key, value] of Object.entries({ state: authorize.searchParams.get("state") ?? "", ...params })) {
    redirect.searchParams.set(key, value);
  }
  return fetch(redirect);
}

describe("McpSignIns", () => {
  it("signs in through the browser with PKCE and saves a login the bridge can refresh", async () => {
    const dir = await tempDir();
    const seen: Seen = { registrations: [], tokenBodies: [] };
    let now = 1_000_000;
    const signIns = new McpSignIns({ dir, fetch: fakeFetch(seen), callbackPorts: [0], now: () => now });
    const start = await signIns.start(SERVER);
    if (start.status !== "open") throw new Error("expected a page to open");
    const authorize = new URL(start.url);
    expect(authorize.origin + authorize.pathname).toBe("https://auth.example.com/authorize");
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "client-1",
      code_challenge_method: "S256",
      scope: "read offline_access",
      resource: SERVER,
    });
    expect(authorize.searchParams.get("redirect_uri")).toMatch(/^http:\/\/localhost:\d+\/callback$/u);
    expect(seen.registrations).toEqual([
      expect.objectContaining({ client_name: "ZLI", token_endpoint_auth_method: "none" }),
    ]);

    const page = await browserReturns(start.url, { code: "good-code" });
    expect(await page.text()).toContain("Signed in to mcp.example.com");
    await signIns.wait(start.attemptId);

    const exchange = seen.tokenBodies[0];
    expect(exchange?.get("grant_type")).toBe("authorization_code");
    expect(exchange?.get("code_verifier")?.length).toBeGreaterThan(40);
    expect(exchange?.get("client_id")).toBe("client-1");
    expect(signIns.status(`${SERVER}/`)).toMatchObject({ signedIn: true, via: "browser" });
    expect(signIns.accessToken(SERVER)).toBe("access-1");
    const file = signIns.tokenFile(SERVER);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);

    now += 3_600_000;
    expect(await freshAccessToken(file, { fetch: fakeFetch(seen), now: () => now })).toBe("access-2");
    const saved = await readSignIn(file);
    expect(saved).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-1" });
    expect(seen.tokenBodies[1]?.get("refresh_token")).toBe("refresh-1");

    const reloaded = new McpSignIns({ dir, now: () => now });
    await reloaded.load();
    expect(reloaded.accessToken(SERVER)).toBe("access-2");
    await reloaded.signOut(SERVER);
    expect(reloaded.status(SERVER)).toEqual({ signedIn: false });
    await expect(readFile(file)).rejects.toThrow();
  });

  it("reuses the saved client for the next sign-in and reports a refused one", async () => {
    const dir = await tempDir();
    const seen: Seen = { registrations: [], tokenBodies: [] };
    const signIns = new McpSignIns({ dir, fetch: fakeFetch(seen), callbackPorts: [0] });
    const first = await signIns.start(SERVER);
    if (first.status !== "open") throw new Error("expected a page to open");
    await browserReturns(first.url, { error: "access_denied", error_description: "The user said no" });
    await expect(signIns.wait(first.attemptId)).rejects.toThrow(
      "mcp.example.com did not finish the sign-in. The user said no",
    );
    await expect(signIns.wait(first.attemptId)).rejects.toThrow("That sign-in already ended.");
    expect(signIns.status(SERVER)).toEqual({ signedIn: false });
  });

  it("stops a sign-in when canceled", async () => {
    const signIns = new McpSignIns({
      dir: await tempDir(),
      fetch: fakeFetch({ registrations: [], tokenBodies: [] }),
      callbackPorts: [0],
    });
    const start = await signIns.start(SERVER);
    if (start.status !== "open") throw new Error("expected a page to open");
    const waiting = signIns.wait(start.attemptId);
    signIns.cancel(start.attemptId);
    await expect(waiting).rejects.toThrow("Sign-in canceled.");
  });

  it("says so when the server does not let apps register", async () => {
    const signIns = new McpSignIns({
      dir: await tempDir(),
      fetch: fakeFetch({ registrations: [], tokenBodies: [] }, { register: false }),
      callbackPorts: [0],
    });
    await expect(signIns.start(SERVER)).rejects.toThrow(
      "auth.example.com does not let apps like ZLI sign in on their own.",
    );
  });

  it("normalizes server addresses", () => {
    expect(normalizeServerUrl(" https://MCP.example.com/mcp/ ")).toBe("https://mcp.example.com/mcp");
    expect(normalizeServerUrl("https://mcp.vercel.com")).toBe("https://mcp.vercel.com");
  });
});
