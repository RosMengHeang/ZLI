import { describe, expect, it } from "vitest";

import {
  discoverSignIn,
  type FetchLike,
  parseBearerChallenge,
  registerClient,
  tokenRequest,
  wellKnownUrls,
} from "./oauth.js";

describe("OAuth helpers", () => {
  it("reads Bearer challenges", () => {
    expect(
      parseBearerChallenge('Bearer realm="OAuth", resource_metadata="https://x.dev/.well-known/a", scope="read write"'),
    ).toEqual({ realm: "OAuth", resource_metadata: "https://x.dev/.well-known/a", scope: "read write" });
    expect(parseBearerChallenge('Bearer error=invalid_token, error_description="say \\"hi\\""')).toEqual({
      error: "invalid_token",
      error_description: 'say "hi"',
    });
    expect(parseBearerChallenge(null)).toEqual({});
  });

  it("builds well-known addresses with the path first", () => {
    expect(wellKnownUrls("https://x.dev/api/mcp/", "oauth-protected-resource")).toEqual([
      "https://x.dev/.well-known/oauth-protected-resource/api/mcp",
      "https://x.dev/.well-known/oauth-protected-resource",
    ]);
    expect(wellKnownUrls("https://x.dev", "oauth-protected-resource")).toEqual([
      "https://x.dev/.well-known/oauth-protected-resource",
    ]);
  });

  it("falls back to the server's own origin for older servers", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://old.dev/mcp") return new Response("", { status: 401 });
      return new Response("nope", { status: 404 });
    }) as FetchLike;
    const discovery = await discoverSignIn("https://old.dev/mcp", fetchImpl);
    expect(discovery.authServer).toMatchObject({
      issuer: "https://old.dev",
      authorizationEndpoint: "https://old.dev/authorize",
      tokenEndpoint: "https://old.dev/token",
      registrationEndpoint: "https://old.dev/register",
    });
    expect(discovery.resource).toBe("https://old.dev/mcp");
  });

  it("ignores endpoints that are not https", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://x.dev/mcp") return new Response("", { status: 401 });
      if (url === "https://x.dev/.well-known/oauth-protected-resource/mcp") {
        return Response.json({ authorization_servers: ["https://auth.x.dev"] });
      }
      if (url.startsWith("https://auth.x.dev/.well-known/")) {
        return Response.json({
          authorization_endpoint: "http://evil.example/a",
          token_endpoint: "https://auth.x.dev/t",
        });
      }
      return new Response("", { status: 404 });
    }) as FetchLike;
    await expect(discoverSignIn("https://x.dev/mcp", fetchImpl)).rejects.toThrow("x.dev did not say how to sign in.");
  });

  it("registers with a client secret when the server only allows that, and sends it with basic auth", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (String(input).endsWith("/register")) {
        return Response.json({ client_id: "c", client_secret: "s", token_endpoint_auth_method: "client_secret_basic" });
      }
      return Response.json({ access_token: "a", expires_in: 60 });
    }) as FetchLike;
    const client = await registerClient(
      {
        issuer: "https://a.dev",
        authorizationEndpoint: "https://a.dev/authorize",
        tokenEndpoint: "https://a.dev/token",
        registrationEndpoint: "https://a.dev/register",
        authMethods: ["client_secret_basic", "client_secret_post"],
        scopes: [],
      },
      "http://localhost:1/callback",
      fetchImpl,
    );
    expect(client).toEqual({ clientId: "c", clientSecret: "s", auth: "client_secret_basic" });
    expect(JSON.parse(String(requests[0]?.init?.body)).token_endpoint_auth_method).toBe("client_secret_post");
    const tokens = await tokenRequest("https://a.dev/token", { grant_type: "x" }, client, fetchImpl, () => 1000);
    expect(tokens).toEqual({ accessToken: "a", expiresAt: 61_000 });
    const headers = requests[1]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from("c:s").toString("base64")}`);
    expect(String(requests[1]?.init?.body)).not.toContain("client_secret");
  });
});
