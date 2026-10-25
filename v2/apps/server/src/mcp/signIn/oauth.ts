import { createHash, randomBytes } from "node:crypto";

import { isPlainObject } from "../../browser-tool/browserTool.js";

export type FetchLike = typeof fetch;

/** A sign-in problem worth showing the person as is. */
export class SignInError extends Error {}

export type ClientAuth = "none" | "client_secret_basic" | "client_secret_post";

export type OAuthClient = {
  clientId: string;
  clientSecret?: string;
  auth: ClientAuth;
};

export type AuthServer = {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  authMethods: string[];
  scopes: string[];
};

export type SignInDiscovery = {
  serverUrl: string;
  /** The RFC 8707 resource the tokens are for. */
  resource: string;
  /** Scopes to ask for; empty leaves scope out. */
  scopes: string[];
  authServer: AuthServer;
};

export type TokenSet = {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
  scope?: string;
};

const REQUEST_TIMEOUT_MS = 15_000;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function signal(): AbortSignal {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Endpoints must be https, or http on this computer, so a token never crosses the network in the clear. */
function safeEndpoint(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname))) return url.toString();
  } catch {
    // Not a URL.
  }
  return undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

async function getJson(fetchImpl: FetchLike, url: string): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: signal() });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    return isPlainObject(body) ? body : undefined;
  } catch {
    return undefined;
  }
}

/** Reads `name="value"` pairs from a Bearer WWW-Authenticate challenge. */
export function parseBearerChallenge(header: string | null): Record<string, string> {
  if (!header) return {};
  const params: Record<string, string> = {};
  for (const match of header.matchAll(/([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/gu)) {
    const key = match[1];
    if (key) params[key.toLowerCase()] = (match[2] ?? match[3] ?? "").replace(/\\(.)/gu, "$1");
  }
  return params;
}

/** Well-known URLs in the order RFC 9728 and the MCP authorization spec say to try them. */
export function wellKnownUrls(base: string, suffix: string): string[] {
  const url = new URL(base);
  const path = url.pathname.replace(/\/+$/u, "");
  const urls = path ? [`${url.origin}/.well-known/${suffix}${path}`] : [];
  urls.push(`${url.origin}/.well-known/${suffix}`);
  return urls;
}

function authServerMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/u, "");
  if (!path) {
    return [`${url.origin}/.well-known/oauth-authorization-server`, `${url.origin}/.well-known/openid-configuration`];
  }
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/openid-configuration${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`,
  ];
}

async function readAuthServer(fetchImpl: FetchLike, issuer: string): Promise<AuthServer | undefined> {
  for (const url of authServerMetadataUrls(issuer)) {
    const body = await getJson(fetchImpl, url);
    const authorizationEndpoint = safeEndpoint(body?.authorization_endpoint);
    const tokenEndpoint = safeEndpoint(body?.token_endpoint);
    if (!body || !authorizationEndpoint || !tokenEndpoint) continue;
    const registrationEndpoint = safeEndpoint(body.registration_endpoint);
    return {
      issuer: typeof body.issuer === "string" ? body.issuer : issuer,
      authorizationEndpoint,
      tokenEndpoint,
      ...(registrationEndpoint ? { registrationEndpoint } : {}),
      authMethods: strings(body.token_endpoint_auth_methods_supported),
      scopes: strings(body.scopes_supported),
    };
  }
  return undefined;
}

/**
 * Finds where to sign in for an MCP server: asks the server without a token, follows its protected
 * resource metadata to the authorization server, and reads that server's metadata.
 */
export async function discoverSignIn(serverUrl: string, fetchImpl: FetchLike = fetch): Promise<SignInDiscovery> {
  const host = hostOf(serverUrl);
  let challenge: Record<string, string> = {};
  try {
    const response = await fetchImpl(serverUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ZLI", version: "1" } },
      }),
      signal: signal(),
    });
    challenge = parseBearerChallenge(response.headers.get("www-authenticate"));
    await response.body?.cancel().catch(() => undefined);
  } catch (error) {
    throw new SignInError(`${host} could not be reached. ${error instanceof Error ? error.message : ""}`.trim());
  }
  const metadataUrls = challenge.resource_metadata
    ? [challenge.resource_metadata]
    : wellKnownUrls(serverUrl, "oauth-protected-resource");
  let resource: Record<string, unknown> | undefined;
  for (const url of metadataUrls) {
    if (!safeEndpoint(url)) continue;
    resource = await getJson(fetchImpl, url);
    if (resource) break;
  }
  const issuers = strings(resource?.authorization_servers);
  // Servers from before protected resource metadata act as their own authorization server.
  const issuer = issuers[0] ?? new URL(serverUrl).origin;
  const authServer =
    (await readAuthServer(fetchImpl, issuer)) ??
    (issuers.length === 0
      ? {
          issuer,
          authorizationEndpoint: `${issuer}/authorize`,
          tokenEndpoint: `${issuer}/token`,
          registrationEndpoint: `${issuer}/register`,
          authMethods: [],
          scopes: [],
        }
      : undefined);
  if (!authServer) throw new SignInError(`${host} did not say how to sign in.`);
  const challengeScopes = challenge.scope?.split(/\s+/u).filter((scope) => scope.length > 0) ?? [];
  const scopes = challengeScopes.length > 0 ? challengeScopes : strings(resource?.scopes_supported);
  return {
    serverUrl,
    resource: typeof resource?.resource === "string" ? resource.resource : serverUrl,
    scopes: withOfflineAccess(scopes, authServer),
    authServer,
  };
}

/** Asks for offline_access when the server offers it, so the login lasts past the first access token. */
function withOfflineAccess(scopes: string[], authServer: AuthServer): string[] {
  if (scopes.length === 0 || scopes.includes("offline_access")) return scopes;
  return authServer.scopes.includes("offline_access") ? [...scopes, "offline_access"] : scopes;
}

function chooseClientAuth(supported: readonly string[]): ClientAuth {
  if (supported.length === 0 || supported.includes("none")) return "none";
  if (supported.includes("client_secret_post")) return "client_secret_post";
  return "client_secret_basic";
}

/** RFC 7591 dynamic client registration for a desktop app with a loopback redirect. */
export async function registerClient(
  authServer: AuthServer,
  redirectUri: string,
  fetchImpl: FetchLike = fetch,
): Promise<OAuthClient> {
  const endpoint = authServer.registrationEndpoint;
  const host = hostOf(authServer.issuer);
  if (!endpoint) throw new SignInError(`${host} does not let apps like ZLI sign in on their own.`);
  const auth = chooseClientAuth(authServer.authMethods);
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: "ZLI",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: auth,
      }),
      signal: signal(),
    });
  } catch (error) {
    throw new SignInError(`${host} could not be reached. ${error instanceof Error ? error.message : ""}`.trim());
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isPlainObject(body) || typeof body.client_id !== "string") {
    throw new SignInError(`${host} turned down ZLI's sign-in request. ${oauthErrorText(body)}`.trim());
  }
  const secret = typeof body.client_secret === "string" ? body.client_secret : undefined;
  const granted = typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : undefined;
  const finalAuth: ClientAuth =
    granted === "none" || granted === "client_secret_basic" || granted === "client_secret_post"
      ? granted
      : secret
        ? auth === "none"
          ? "client_secret_post"
          : auth
        : "none";
  return { clientId: body.client_id, ...(secret ? { clientSecret: secret } : {}), auth: finalAuth };
}

export type Pkce = { verifier: string; challenge: string };

export function createPkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function randomState(): string {
  return randomBytes(16).toString("base64url");
}

export function authorizeUrl(
  discovery: SignInDiscovery,
  client: OAuthClient,
  options: { redirectUri: string; state: string; pkce: Pkce },
): string {
  const url = new URL(discovery.authServer.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("code_challenge", options.pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", options.state);
  if (discovery.scopes.length > 0) url.searchParams.set("scope", discovery.scopes.join(" "));
  url.searchParams.set("resource", discovery.resource);
  return url.toString();
}

function oauthErrorText(body: unknown): string {
  if (!isPlainObject(body)) return "";
  const description = typeof body.error_description === "string" ? body.error_description : "";
  const code = typeof body.error === "string" ? body.error : "";
  return description || code;
}

/** Posts a token request (RFC 6749 section 4.1.3 and 6) and reads the tokens. */
export async function tokenRequest(
  endpoint: string,
  params: Record<string, string>,
  client: OAuthClient,
  fetchImpl: FetchLike = fetch,
  now: () => number = Date.now,
): Promise<TokenSet> {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (client.auth === "client_secret_basic" && client.clientSecret) {
    const pair = `${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`;
    headers.authorization = `Basic ${Buffer.from(pair).toString("base64")}`;
  } else {
    body.set("client_id", client.clientId);
    if (client.clientSecret) body.set("client_secret", client.clientSecret);
  }
  const host = hostOf(endpoint);
  let response: Response;
  try {
    response = await fetchImpl(endpoint, { method: "POST", headers, body: body.toString(), signal: signal() });
  } catch (error) {
    throw new SignInError(`${host} could not be reached. ${error instanceof Error ? error.message : ""}`.trim());
  }
  const text = await response.text().catch(() => "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = Object.fromEntries(new URLSearchParams(text));
  }
  if (!response.ok || !isPlainObject(parsed) || typeof parsed.access_token !== "string" || parsed.error) {
    const error = new SignInError(`${host} did not finish the sign-in. ${oauthErrorText(parsed)}`.trim());
    Object.assign(error, { status: response.status });
    if (isPlainObject(parsed) && typeof parsed.error === "string") Object.assign(error, { code: parsed.error });
    throw error;
  }
  const expiresIn = Number(parsed.expires_in);
  return {
    accessToken: parsed.access_token,
    ...(typeof parsed.refresh_token === "string" ? { refreshToken: parsed.refresh_token } : {}),
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: now() + expiresIn * 1000 } : {}),
    ...(typeof parsed.scope === "string" ? { scope: parsed.scope } : {}),
  };
}

/** The OAuth error code a token request failed with, such as authorization_pending. */
export function oauthErrorCode(error: unknown): string | undefined {
  return isPlainObject(error) && typeof error.code === "string" ? error.code : undefined;
}
