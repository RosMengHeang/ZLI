import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import { appsCallReads } from "./appsPolicy.js";

/** Where agents reach the connected apps: the real Composio address and the key that goes with it. */
export type AppsUpstream = { url: string; headers: Readonly<Record<string, string>> };

/** One call that changes something in the person's apps, and who is making it. */
export type AppsCall = { worktreeId?: string; tool: string; params?: Record<string, unknown>; signal?: AbortSignal };

/**
 * What happens to a call that changes something: it goes ahead, it is refused, or it is held as a card the person
 * sends or discards later (ZLI runs it then); the agent is told which, at once.
 */
export type AppsVerdict = { allowed: true } | { allowed: false; reason: string } | { held: true; reason: string };

/** What came back from running a held call for the person: whether it worked, and Composio's words. */
export type AppsRunResult = { ok: boolean; text: string };

const PATH = "/composio";
/** An MCP request is a few kilobytes; anything far larger is not one. */
const MAX_BODY = 4 * 1024 * 1024;
/** What an MCP client sends that Composio needs; nothing else passes, so no local header leaks out. */
const REQUEST_HEADERS = ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"];
const RESPONSE_HEADERS = ["content-type", "mcp-session-id", "cache-control"];

const UNKNOWN_CALLER =
  "This call was not performed: it changes something in the person's apps, and ZLI could not tell which chat it came " +
  "from to ask them. Don't retry. Tell the person in one line what you wanted to do, so they can do it or ask you again.";
const UNREADABLE =
  "This call was not performed: ZLI could not read it. Don't retry with the same shape; call one tool at a time.";

/**
 * A local stand-in for Composio, and the one place every connected-app call crosses.
 *
 * - The key never reaches an agent: agents get this loopback address and a token, and ZLI adds the key on the way
 *   out. Tokens are random at each start and only work on this computer.
 * - Each worktree (a buddy's home, a job) gets its own token, so ZLI knows whose call it is.
 * - Reading passes. Anything that sends, posts, changes, deletes or runs code waits for the person's answer on a
 *   card in that chat, whatever the agent, its permission, or whether it called from its shell. Calls ZLI cannot
 *   read are refused.
 */
export class AppsProxy {
  /** Token digest → the worktree it was made for ("" for the shared one, which may only read). */
  readonly #tokens = new Map<string, string>();
  readonly #byWorktree = new Map<string, string>();
  #server: Server | undefined;
  #port: number | undefined;

  constructor(
    private readonly options: {
      upstream: () => AppsUpstream | undefined;
      /** Asks the person about a call that changes something. Without it, such calls are refused. */
      decide?: (call: AppsCall) => Promise<AppsVerdict>;
      fetch?: typeof fetch;
    },
  ) {}

  async start(): Promise<void> {
    if (this.#server) return;
    const server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(502);
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
    this.#tokens.clear();
    this.#byWorktree.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** The address and header an agent in `worktreeId` gets, once started. Without a worktree: read-only. */
  endpoint(worktreeId?: string): { url: string; headers: Record<string, string> } | undefined {
    if (this.#port === undefined) return undefined;
    const key = worktreeId ?? "";
    let token = this.#byWorktree.get(key);
    if (!token) {
      token = randomBytes(32).toString("hex");
      this.#byWorktree.set(key, token);
      this.#tokens.set(digest(token), key);
    }
    return { url: `http://127.0.0.1:${this.#port}${PATH}`, headers: { Authorization: `Bearer ${token}` } };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Only a local MCP client: the right path and host (no DNS rebinding), no browser page, and a token ZLI made.
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== PATH || request.headers.host !== `127.0.0.1:${this.#port}` || request.headers.origin) {
      response.writeHead(404).end();
      return;
    }
    const caller = this.caller(request.headers.authorization);
    if (caller === undefined) {
      response.writeHead(401).end();
      return;
    }
    if (!["GET", "POST", "DELETE"].includes(request.method ?? "")) {
      response.writeHead(405).end();
      return;
    }
    const upstream = this.options.upstream();
    if (!upstream) {
      response.writeHead(503, { "content-type": "text/plain" }).end("No Composio key is saved in ZLI.");
      return;
    }
    const body = request.method === "POST" ? await readBody(request) : undefined;
    if (body === null) {
      response.writeHead(413).end();
      return;
    }
    if (body) {
      // An agent that hangs up while its call waits for the person takes the question back with it, so a late
      // Allow never runs a call nobody is waiting for.
      const hungUp = new AbortController();
      response.on("close", () => {
        if (!response.writableFinished) hungUp.abort();
      });
      const refusal = await this.verdict(body, caller, hungUp.signal);
      if (hungUp.signal.aborted) return;
      if (refusal) {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(refusal));
        return;
      }
    }
    await this.forward(request, response, upstream, body);
  }

  /**
   * The answer to send instead of Composio's when a call may not go ahead, or undefined to pass it on. A batch of
   * several messages, or one ZLI cannot parse, goes ahead only if nothing in it is a tool call.
   */
  private async verdict(body: Buffer, caller: string, signal: AbortSignal): Promise<unknown> {
    let message: unknown;
    try {
      message = JSON.parse(body.toString("utf8"));
    } catch {
      return { jsonrpc: "2.0", id: null, error: { code: -32700, message: UNREADABLE } };
    }
    const frames = Array.isArray(message) ? message : [message];
    const calls = frames.filter((frame) => (frame as { method?: unknown } | null)?.method === "tools/call");
    if (calls.length === 0) return undefined;
    const first = calls[0] as { id?: unknown; params?: { name?: unknown; arguments?: unknown } };
    const id = typeof first.id === "string" || typeof first.id === "number" ? first.id : null;
    if (frames.length > 1) return refusal(id, UNREADABLE);
    const tool = typeof first.params?.name === "string" ? first.params.name : "";
    const args = first.params?.arguments;
    const params =
      typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : undefined;
    if (!tool) return refusal(id, UNREADABLE);
    if (appsCallReads(tool, params)) return undefined;
    if (!caller || !this.options.decide) return refusal(id, UNKNOWN_CALLER);
    const answer = await this.options
      .decide({ worktreeId: caller, tool, ...(params ? { params } : {}), signal })
      .catch((): AppsVerdict => ({ allowed: false, reason: UNKNOWN_CALLER }));
    if ("held" in answer) return held(id, answer.reason);
    return answer.allowed ? undefined : refusal(id, answer.reason);
  }

  /**
   * Runs one call the person sent from its card, with the saved key: ZLI makes it, so it no longer depends on
   * the agent still waiting.
   */
  async run(tool: string, params: Record<string, unknown> | undefined): Promise<AppsRunResult> {
    const upstream = this.options.upstream();
    if (!upstream) return { ok: false, text: "No Composio key is saved in ZLI." };
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(upstream.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...upstream.headers,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: tool, arguments: params ?? {} },
        }),
        redirect: "error",
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      return { ok: false, text: "Composio could not be reached." };
    }
    // Whatever comes back is shown in the chat, so the key never rides along in an error.
    const text = withoutKey(await response.text().catch(() => ""), upstream);
    if (!response.ok) return { ok: false, text: `Composio answered HTTP ${response.status}.` };
    const reply = mcpReply(text) as
      | {
          error?: { message?: unknown };
          result?: { isError?: unknown; content?: { type?: unknown; text?: unknown }[] };
        }
      | undefined;
    if (!reply) return { ok: false, text: "Composio sent an answer ZLI could not read." };
    if (reply.error) return { ok: false, text: String(reply.error.message ?? "Composio refused the call.") };
    const said = (reply.result?.content ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n");
    return { ok: reply.result?.isError !== true && !failedInside(said), text: said };
  }

  private async forward(
    request: IncomingMessage,
    response: ServerResponse,
    upstream: AppsUpstream,
    body: Buffer | undefined,
  ): Promise<void> {
    const headers: Record<string, string> = {};
    for (const name of REQUEST_HEADERS) {
      const value = request.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    const abort = new AbortController();
    request.on("close", () => abort.abort());
    response.on("close", () => abort.abort());
    const upstreamResponse = await (this.options.fetch ?? fetch)(upstream.url, {
      method: request.method ?? "POST",
      headers: { ...headers, ...upstream.headers },
      ...(body ? { body: new Uint8Array(body) } : {}),
      redirect: "error",
      signal: abort.signal,
    });
    const out: Record<string, string> = {};
    for (const name of RESPONSE_HEADERS) {
      const value = upstreamResponse.headers.get(name);
      if (value) out[name] = value;
    }
    response.writeHead(upstreamResponse.status, out);
    if (!upstreamResponse.body) {
      response.end();
      return;
    }
    // Composio can repeat a request header back in an error, so the key is cut out of everything the agent reads.
    Readable.fromWeb(upstreamResponse.body as WebReadableStream)
      .pipe(keyScrubber(secretsOf(upstream)))
      .pipe(response);
  }

  /** The worktree a token was made for ("" for the shared one), or undefined for no valid token. */
  private caller(header: string | undefined): string | undefined {
    const token = /^Bearer ([0-9a-f]{64})$/u.exec(header ?? "")?.[1];
    return token ? this.#tokens.get(digest(token)) : undefined;
  }
}

/** A tool result the model reads: nothing ran, and why. */
function refusal(id: string | number | null, text: string): unknown {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } };
}

/** A tool result the model reads: the call is waiting on the person, so it should not wait or retry. */
function held(id: string | number | null, text: string): unknown {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } };
}

/** An MCP reply comes as plain JSON or as server-sent events; this finds the JSON either way. */
function mcpReply(text: string): unknown {
  const events = text
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  for (const candidate of [...events.reverse(), text]) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Not this one.
    }
  }
  return undefined;
}

/** Composio reports a failed app action inside a successful tool result: {"successful": false, ...}. */
function failedInside(said: string): boolean {
  try {
    const parsed = JSON.parse(said) as {
      successful?: unknown;
      data?: { results?: { response?: { successful?: unknown } }[] };
    };
    if (parsed.successful === false) return true;
    return (parsed.data?.results ?? []).some((entry) => entry?.response?.successful === false);
  } catch {
    return false;
  }
}

function withoutKey(text: string, upstream: AppsUpstream): string {
  return secretsOf(upstream).reduce((clean, value) => clean.split(value).join("[key]"), text);
}

/** The header values long enough to be a key; shorter ones would match ordinary text. */
function secretsOf(upstream: AppsUpstream): string[] {
  return Object.values(upstream.headers).filter((value) => value.length >= 8);
}

/**
 * Replaces each secret in a byte stream, even one split across chunks: the last few bytes of each chunk wait for
 * the next one, so a key cut in two is still found. Keys are ASCII, so matching on bytes is exact.
 */
export function keyScrubber(secrets: readonly string[]): Transform {
  const needles = secrets.map((secret) => Buffer.from(secret, "utf8"));
  const hold = Math.max(0, ...needles.map((needle) => needle.length - 1));
  const mask = Buffer.from("[key]");
  let pending = Buffer.alloc(0);
  const clean = (bytes: Buffer): Buffer => {
    let out = bytes;
    for (const needle of needles) {
      const parts: Buffer[] = [];
      let from = 0;
      for (let at = out.indexOf(needle); at !== -1; at = out.indexOf(needle, from)) {
        parts.push(out.subarray(from, at), mask);
        from = at + needle.length;
      }
      if (parts.length) out = Buffer.concat([...parts, out.subarray(from)]);
    }
    return out;
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      const joined = clean(Buffer.concat([pending, chunk]));
      const keep = Math.min(hold, joined.length);
      pending = joined.subarray(joined.length - keep);
      done(null, joined.subarray(0, joined.length - keep));
    },
    flush(done) {
      done(null, clean(pending));
    },
  });
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** The request body, or null when it is too large to be an MCP message. */
async function readBody(request: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
