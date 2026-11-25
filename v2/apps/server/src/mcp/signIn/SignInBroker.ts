import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename } from "node:path";

import { freshAccessToken, markSignInExpired } from "./tokenFile.js";

const PATH = "/sign-in";
const MAX_BODY = 16 * 1024;

/** Where a connect bridge asks for one server's access token, and the key that lets it. */
export type SignInGrant = { url: string; token: string };

/** The environment variable a bridge finds its grant in. The prefix lets it leave settings files for the agent's env. */
export const SIGN_IN_ENV_PREFIX = "ZLI_CONNECT_SIGN_IN_";

export function signInEnvName(tokenFile: string): string {
  return `${SIGN_IN_ENV_PREFIX}${basename(tokenFile, ".json").replace(/[^A-Za-z0-9]/gu, "_")}`;
}

/**
 * Hands connect bridges an access token without letting them read the saved login. Logins are sealed on disk with a
 * key only this process holds, and a bridge gets a fresh access token for its one server from here. The refresh
 * token and every other server's login stay in this process, so an agent that is tricked into reading files or its
 * environment learns at most a short-lived token for a server it already uses.
 */
export class SignInBroker {
  /** Key digest → the login file it unlocks. */
  readonly #files = new Map<string, string>();
  readonly #byFile = new Map<string, string>();
  #server: Server | undefined;
  #port: number | undefined;

  constructor(
    private readonly options: {
      fresh?: typeof freshAccessToken;
      expire?: typeof markSignInExpired;
    } = {},
  ) {}

  async start(): Promise<void> {
    if (this.#server) return;
    const server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    this.#server = server;
    this.#port = (server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    this.#port = undefined;
    this.#files.clear();
    this.#byFile.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** The address and key a bridge uses for the login in `tokenFile`, once started. The same key for each file. */
  grant(tokenFile: string): SignInGrant | undefined {
    if (this.#port === undefined) return undefined;
    let token = this.#byFile.get(tokenFile);
    if (!token) {
      token = randomBytes(32).toString("hex");
      this.#byFile.set(tokenFile, token);
      this.#files.set(digest(token), tokenFile);
    }
    return { url: `http://127.0.0.1:${this.#port}${PATH}`, token };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Only a local client: the right path and host (no DNS rebinding), no browser page, POST, and a key ZLI made.
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== PATH || request.headers.host !== `127.0.0.1:${this.#port}` || request.headers.origin) {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const file = this.fileFor(request.headers.authorization);
    if (!file) {
      response.writeHead(401).end();
      return;
    }
    const body = await readJson(request);
    if (body === undefined) {
      response.writeHead(400).end();
      return;
    }
    if (typeof body.rejected === "string") {
      await (this.options.expire ?? markSignInExpired)(file, body.rejected);
      send(response, {});
      return;
    }
    const accessToken = await (this.options.fresh ?? freshAccessToken)(file, { force: body.force === true });
    send(response, accessToken ? { accessToken } : {});
  }

  private fileFor(header: string | undefined): string | undefined {
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return undefined;
    const presented = digest(header.slice("Bearer ".length).trim());
    for (const [known, file] of this.#files)
      if (timingSafeEqual(Buffer.from(known), Buffer.from(presented))) return file;
    return undefined;
  }
}

/**
 * What a bridge calls: a fresh access token for its server, or undefined when there is no usable login.
 * `force` says the server just turned the last token down.
 */
export async function requestAccessToken(
  grant: SignInGrant,
  force: boolean,
  fetcher: typeof fetch = fetch,
): Promise<string | undefined> {
  const reply = await post(grant, { force }, fetcher);
  return typeof reply?.accessToken === "string" && reply.accessToken ? reply.accessToken : undefined;
}

/** Tells the broker the server turned `token` down, so the login shows as expired in ZLI. */
export async function reportRejectedToken(
  grant: SignInGrant,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  await post(grant, { rejected: token }, fetcher);
}

export function parseSignInGrant(text: string | undefined): SignInGrant | undefined {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as Partial<SignInGrant> | null;
    if (typeof value?.url !== "string" || typeof value.token !== "string" || !value.token) return undefined;
    const url = new URL(value.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return undefined;
    return { url: value.url, token: value.token };
  } catch {
    return undefined;
  }
}

async function post(
  grant: SignInGrant,
  body: Record<string, unknown>,
  fetcher: typeof fetch,
): Promise<Record<string, unknown> | undefined> {
  const response = await fetcher(grant.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${grant.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`ZLI did not hand out a sign-in (HTTP ${response.status}).`);
  const value = (await response.json()) as unknown;
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function send(response: ServerResponse, value: Record<string, unknown>): void {
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return undefined;
    chunks.push(chunk as Buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
