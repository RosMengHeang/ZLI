import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";

import type { BrowserControlEndpoint } from "@zli-v2/contracts";

import { BrowserControlError, type BrowserControlDispatch } from "./BrowserControlActions.js";

const MAX_BODY_BYTES = 1024 * 1024;
const ROUTE = /^\/v1\/([a-z]+)$/u;

export type BrowserControlServerOptions = {
  /** Where the port and token are published for the zli-browser tool. */
  readonly endpointPath: string;
  readonly dispatch: BrowserControlDispatch;
  readonly token?: string;
  readonly pid?: number;
};

/**
 * Local HTTP endpoint for agent browser control. It binds to loopback only, and every request
 * must carry the bearer token from the endpoint file, which only the current user can read.
 */
export class BrowserControlServer {
  readonly #options: BrowserControlServerOptions;
  readonly #token: string;
  readonly #tokenDigest: Buffer;
  #server: Server | undefined;
  #endpoint: BrowserControlEndpoint | undefined;

  constructor(options: BrowserControlServerOptions) {
    this.#options = options;
    this.#token = options.token ?? randomBytes(32).toString("hex");
    this.#tokenDigest = digest(this.#token);
  }

  get endpoint(): BrowserControlEndpoint | undefined {
    return this.#endpoint;
  }

  async start(): Promise<BrowserControlEndpoint> {
    if (this.#endpoint) return this.#endpoint;
    const server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    // Waits such as browser_wait can legitimately take up to two minutes.
    server.requestTimeout = 180_000;
    server.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("The browser control service did not bind to a port.");
    }
    this.#server = server;
    this.#endpoint = { version: 1, port: address.port, token: this.#token, pid: this.#options.pid ?? process.pid };
    writeEndpointFile(this.#options.endpointPath, this.#endpoint);
    return this.#endpoint;
  }

  /** Synchronous so it can run from app quit handlers. Leaves a newer instance's endpoint file alone. */
  stop(): void {
    this.#server?.close();
    this.#server?.closeAllConnections?.();
    this.#server = undefined;
    if (!this.#endpoint) return;
    this.#endpoint = undefined;
    try {
      const written = JSON.parse(readFileSync(this.#options.endpointPath, "utf8")) as { token?: unknown };
      if (written.token === this.#token) rmSync(this.#options.endpointPath, { force: true });
    } catch {
      // Already gone or unreadable; nothing of ours to remove.
    }
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      // Browser pages must never drive this service, even when they guess the port.
      if (request.headers.origin !== undefined) return send(response, 403, { ok: false, error: "Forbidden." });
      if (!this.#authorized(request.headers.authorization))
        return send(response, 401, { ok: false, error: "Missing or invalid browser control token." });
      const match = ROUTE.exec(request.url ?? "");
      if (!match?.[1]) return send(response, 404, { ok: false, error: "Unknown browser control route." });
      if (request.method !== "POST") return send(response, 405, { ok: false, error: "Use POST." });
      const body = await readJsonBody(request);
      const result = await this.#options.dispatch(match[1], body);
      send(response, 200, { ok: true, result: result ?? null });
    } catch (cause) {
      const status =
        cause instanceof BrowserControlError
          ? cause.status
          : isZodError(cause)
            ? 400
            : cause instanceof BodyError
              ? cause.status
              : 500;
      send(response, status, { ok: false, error: describeError(cause) });
    }
  }

  #authorized(header: string | undefined): boolean {
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
    return timingSafeEqual(digest(header.slice("Bearer ".length).trim()), this.#tokenDigest);
  }
}

function writeEndpointFile(path: string, endpoint: BrowserControlEndpoint): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(endpoint)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

class BodyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new BodyError("Request body is too large.", 413);
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new BodyError("Request body is not valid JSON.", 400);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new BodyError("Request body must be a JSON object.", 400);
  return value;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function isZodError(value: unknown): value is { issues: Array<{ path: PropertyKey[]; message: string }> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "issues" in value &&
    Array.isArray((value as { issues: unknown }).issues) &&
    String((value as { name?: unknown }).name).includes("ZodError")
  );
}

function describeError(cause: unknown): string {
  if (isZodError(cause))
    return cause.issues
      .map((issue) => `${issue.path.map(String).join(".") || "input"}: ${issue.message}`)
      .join("; ")
      .slice(0, 2_000);
  if (cause instanceof Error) return cause.message.slice(0, 2_000) || "The browser action failed.";
  return "The browser action failed.";
}
