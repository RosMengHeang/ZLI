import { createInterface } from "node:readline";

import { createToolFilter, type ToolFilter } from "./toolFilter.js";

export type BridgeOptions = {
  /** Remote MCP server URL. */
  url: string;
  /** Extra static headers, from the header file. */
  headers: Record<string, string>;
  /** Current access token, or undefined when not signed in. force=true after a 401 asks for a refreshed one. */
  getToken(force: boolean): Promise<string | undefined>;
  /** Server name, for error messages. */
  name: string;
  fetch?: typeof fetch;
  input: NodeJS.ReadableStream;
  output: { write(line: string): unknown };
  log?: (message: string) => void;
  /** Tools the person turned off: left out of tools/list, and calls to them are refused. */
  hiddenTools?: readonly string[];
  /** The server turned down this token even after a forced refresh, so the saved login no longer works. */
  onSignInRejected?: (token: string) => void | Promise<void>;
};

type JsonRpcId = string | number;
type Message = Record<string, unknown>;

export type SseEvent = { event: string; data: string; id?: string };

export const SIGN_IN_CODE = -32001;
const FAILURE_CODE = -32000;
const DELETE_TIMEOUT_MS = 3_000;

/** Runs until `input` ends, then closes the remote session. */
export async function runMcpBridge(options: BridgeOptions): Promise<void> {
  await new McpBridge(options).run();
}

class McpBridge {
  private readonly fetch: typeof fetch;
  private readonly log: (message: string) => void;
  private readonly shutdown = new AbortController();
  private closed = false;
  private sessionId: string | undefined;
  private protocolVersion: string | undefined;
  private initMessage: Message | undefined;
  /** Settles once the latest initialize POST has finished, so later messages carry its session id. */
  private ready: Promise<unknown> = Promise.resolve();
  private reinit: Promise<boolean> | undefined;
  private firstPost = true;
  private serverStreamTried = false;
  private legacyEndpoint: URL | undefined;
  private readonly filter: ToolFilter | undefined;

  constructor(private readonly options: BridgeOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.log = options.log ?? (() => undefined);
    this.filter =
      options.hiddenTools && options.hiddenTools.length > 0
        ? createToolFilter(options.name, options.hiddenTools)
        : undefined;
  }

  async run(): Promise<void> {
    const lines = createInterface({ input: this.options.input, crlfDelay: Number.POSITIVE_INFINITY });
    for await (const line of lines) {
      if (line.trim() === "") continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.log(`Skipped a line that is not JSON: ${line.slice(0, 200)}`);
        continue;
      }
      this.dispatch(message);
    }
    await this.close();
  }

  private dispatch(incoming: unknown): void {
    let message = incoming;
    if (this.filter) {
      const { forward, reply } = this.filter.fromClient(incoming);
      if (reply !== undefined) this.writeRaw(reply);
      if (forward === undefined) return;
      message = forward;
    }
    if (isInitialize(message)) {
      this.initMessage = message;
      this.ready = this.ready.then(() => this.deliver(message)).catch((cause) => this.unexpected(cause));
      return;
    }
    void this.ready.then(() => this.deliver(message)).catch((cause) => this.unexpected(cause));
  }

  private unexpected(cause: unknown): void {
    this.log(`Bridge error: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}`);
  }

  private async close(): Promise<void> {
    this.closed = true;
    this.shutdown.abort();
    const sessionId = this.sessionId;
    if (!sessionId || this.legacyEndpoint) return;
    try {
      const headers = await this.headers(await this.token(false), "application/json, text/event-stream");
      headers.set("mcp-session-id", sessionId);
      if (this.protocolVersion) headers.set("mcp-protocol-version", this.protocolVersion);
      const response = await this.fetch(this.options.url, {
        method: "DELETE",
        headers,
        signal: AbortSignal.timeout(DELETE_TIMEOUT_MS),
      });
      await discard(response);
    } catch {
      // The server drops idle sessions on its own.
    }
  }

  private write(message: unknown): void {
    this.writeRaw(this.filter ? this.filter.fromServer(message) : message);
  }

  private writeRaw(message: unknown): void {
    if (this.closed) return;
    this.options.output.write(`${JSON.stringify(message)}\n`);
  }

  /**
   * Sends with the current token and, after a 401, once more with a forced refresh. Undefined when the
   * server still wants a sign-in.
   */
  private async authorized(send: (token: string | undefined) => Promise<Response>): Promise<Response | undefined> {
    const first = await this.token(false);
    let response = await send(first);
    if (response.status !== 401) return response;
    await discard(response);
    const forced = await this.token(true);
    if (forced) {
      response = await send(forced);
      if (response.status !== 401) return response;
      await discard(response);
    }
    const rejected = forced ?? first;
    if (rejected && this.options.onSignInRejected) {
      try {
        await this.options.onSignInRejected(rejected);
      } catch (cause) {
        this.log(`Could not note the expired sign-in for ${this.options.name}: ${reason(cause)}`);
      }
    }
    return undefined;
  }

  private async token(force: boolean): Promise<string | undefined> {
    try {
      return (await this.options.getToken(force)) || undefined;
    } catch (cause) {
      this.log(`Could not read the sign-in for ${this.options.name}: ${reason(cause)}`);
      return undefined;
    }
  }

  private async headers(token: string | undefined, accept: string): Promise<Headers> {
    const headers = new Headers(this.options.headers);
    headers.set("accept", accept);
    if (token) headers.set("authorization", `Bearer ${token}`);
    return headers;
  }

  /** Sends one message (or batch) and writes what comes back. Returns false when it failed. */
  private async deliver(
    message: unknown,
    options: { write?: boolean; internal?: boolean; sessionRetried?: boolean } = {},
  ): Promise<boolean> {
    if (this.closed) return false;
    const write = options.write ?? true;
    if (this.reinit && !options.internal) await this.reinit;
    if (this.legacyEndpoint) return this.deliverLegacy(message, write);
    const initialize = isInitialize(message);
    const sentSession = initialize ? undefined : this.sessionId;
    const post = async (token: string | undefined) => {
      const headers = await this.headers(token, "application/json, text/event-stream");
      headers.set("content-type", "application/json");
      if (sentSession) headers.set("mcp-session-id", sentSession);
      if (!initialize && this.protocolVersion) headers.set("mcp-protocol-version", this.protocolVersion);
      return this.fetch(this.options.url, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: this.shutdown.signal,
      });
    };

    let response: Response;
    try {
      const answered = await this.authorized(post);
      if (!answered) {
        this.firstPost = false;
        this.fail(message, write, SIGN_IN_CODE, signInMessage(this.options.name));
        return false;
      }
      response = answered;
    } catch (cause) {
      if (this.closed) return false;
      this.fail(message, write, FAILURE_CODE, `${this.options.name} could not be reached: ${reason(cause)}.`);
      return false;
    }

    const first = this.firstPost;
    this.firstPost = false;
    if (initialize && first && (response.status === 404 || response.status === 405)) {
      await discard(response);
      return this.switchToLegacy(message, write);
    }
    if (response.status === 404 && sentSession && !initialize && !options.sessionRetried) {
      await discard(response);
      if (!(await this.renewSession(sentSession))) {
        this.fail(
          message,
          write,
          FAILURE_CODE,
          `${this.options.name} ended the session and could not start a new one.`,
        );
        return false;
      }
      return this.deliver(message, { ...options, sessionRetried: true });
    }
    if (!response.ok) {
      await discard(response);
      this.fail(message, write, FAILURE_CODE, `${this.options.name} answered ${statusLine(response)}.`);
      return false;
    }
    if (initialize) {
      const sessionId = response.headers.get("mcp-session-id");
      if (sessionId) this.sessionId = sessionId;
    }
    const ok = await this.readBody(response, message, write, initialize);
    if (ok && isInitializedNotification(message)) this.openServerStream();
    return ok;
  }

  private async readBody(response: Response, message: unknown, write: boolean, initialize: boolean): Promise<boolean> {
    const handle = (payload: unknown) => {
      for (const item of Array.isArray(payload) ? payload : [payload]) {
        if (initialize) this.noteProtocolVersion(item, message);
        if (write) this.write(item);
      }
    };
    try {
      if (response.status === 202 || response.status === 204 || !response.body) {
        await discard(response);
        return true;
      }
      const type = (response.headers.get("content-type") ?? "").toLowerCase();
      if (type.includes("text/event-stream")) {
        for await (const event of readSse(response.body, this.shutdown.signal)) {
          if (event.event !== "message") continue;
          const payload = parseJson(event.data);
          if (payload === undefined) this.log(`Skipped a server event that is not JSON: ${event.data.slice(0, 200)}`);
          else handle(payload);
        }
        return true;
      }
      if (type.includes("application/json")) {
        const text = await response.text();
        if (text.trim() === "") return true;
        const payload = parseJson(text);
        if (payload === undefined) {
          this.fail(message, write, FAILURE_CODE, `${this.options.name} sent a reply that is not JSON.`);
          return false;
        }
        handle(payload);
        return true;
      }
      await discard(response);
      return true;
    } catch (cause) {
      if (this.closed) return false;
      this.fail(message, write, FAILURE_CODE, `${this.options.name} stopped answering: ${reason(cause)}.`);
      return false;
    }
  }

  private noteProtocolVersion(item: unknown, message: unknown): void {
    if (!isObject(item) || !isObject(message) || item.id !== message.id || !isObject(item.result)) return;
    const version = item.result.protocolVersion;
    if (typeof version === "string" && version) this.protocolVersion = version;
  }

  /** One shared re-initialize for every request that saw the expired session. */
  private async renewSession(expired: string): Promise<boolean> {
    if (this.reinit) return this.reinit;
    if (this.sessionId !== expired) return this.sessionId !== undefined;
    const init = this.initMessage;
    if (!init) return false;
    this.sessionId = undefined;
    this.reinit = (async () => {
      this.log(`${this.options.name} session expired; starting a new one.`);
      if (!(await this.deliver(init, { write: false, internal: true, sessionRetried: true }))) return false;
      if (!this.sessionId) return false;
      await this.deliver(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { write: false, internal: true, sessionRetried: true },
      );
      return true;
    })().finally(() => {
      this.reinit = undefined;
    });
    return this.reinit;
  }

  /** The optional GET stream for server-initiated messages. Tried once; servers may not offer it. */
  private openServerStream(): void {
    if (this.serverStreamTried || this.legacyEndpoint || this.closed) return;
    this.serverStreamTried = true;
    void (async () => {
      try {
        const headers = await this.headers(await this.token(false), "text/event-stream");
        if (this.sessionId) headers.set("mcp-session-id", this.sessionId);
        if (this.protocolVersion) headers.set("mcp-protocol-version", this.protocolVersion);
        const response = await this.fetch(this.options.url, {
          method: "GET",
          headers,
          signal: this.shutdown.signal,
        });
        const type = (response.headers.get("content-type") ?? "").toLowerCase();
        if (!response.ok || !response.body || !type.includes("text/event-stream")) {
          await discard(response);
          return;
        }
        for await (const event of readSse(response.body, this.shutdown.signal)) {
          if (event.event !== "message") continue;
          const payload = parseJson(event.data);
          if (payload !== undefined) for (const item of Array.isArray(payload) ? payload : [payload]) this.write(item);
        }
      } catch (cause) {
        if (!this.closed) this.log(`${this.options.name} server stream stopped: ${reason(cause)}`);
      }
    })();
  }

  /** The 2024-11-05 HTTP+SSE transport: one GET stream for replies, POSTs to the endpoint it names. */
  private async switchToLegacy(message: unknown, write: boolean): Promise<boolean> {
    this.log(`${this.options.name} does not take streamable HTTP; trying the older SSE transport.`);
    const open = async (token: string | undefined) =>
      this.fetch(this.options.url, {
        method: "GET",
        headers: await this.headers(token, "text/event-stream"),
        signal: this.shutdown.signal,
      });
    let response: Response;
    try {
      const answered = await this.authorized(open);
      if (!answered) {
        this.fail(message, write, SIGN_IN_CODE, signInMessage(this.options.name));
        return false;
      }
      response = answered;
    } catch (cause) {
      if (this.closed) return false;
      this.fail(message, write, FAILURE_CODE, `${this.options.name} could not be reached: ${reason(cause)}.`);
      return false;
    }
    if (!response.ok || !response.body) {
      await discard(response);
      this.fail(message, write, FAILURE_CODE, `${this.options.name} answered ${statusLine(response)}.`);
      return false;
    }
    const body = response.body;
    const endpoint = await new Promise<URL | undefined>((resolve) => {
      void (async () => {
        try {
          for await (const event of readSse(body, this.shutdown.signal)) {
            if (event.event === "endpoint") {
              // Later endpoint events are ignored: the promise has already settled.
              try {
                resolve(new URL(event.data.trim(), this.options.url));
              } catch {
                resolve(undefined);
              }
              continue;
            }
            if (event.event !== "message") continue;
            const payload = parseJson(event.data);
            if (payload !== undefined)
              for (const item of Array.isArray(payload) ? payload : [payload]) this.write(item);
          }
          if (!this.closed) this.log(`${this.options.name} closed its event stream.`);
        } catch (cause) {
          if (!this.closed) this.log(`${this.options.name} event stream stopped: ${reason(cause)}`);
        }
        resolve(undefined);
      })();
    });
    if (!endpoint) {
      if (this.closed) return false;
      this.fail(message, write, FAILURE_CODE, `${this.options.name} did not say where to send messages.`);
      return false;
    }
    this.legacyEndpoint = endpoint;
    return this.deliverLegacy(message, write);
  }

  private async deliverLegacy(message: unknown, write: boolean): Promise<boolean> {
    const endpoint = this.legacyEndpoint;
    if (!endpoint) return false;
    const post = async (token: string | undefined) => {
      const headers = await this.headers(token, "application/json, text/event-stream");
      headers.set("content-type", "application/json");
      return this.fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: this.shutdown.signal,
      });
    };
    try {
      const response = await this.authorized(post);
      if (!response) {
        this.fail(message, write, SIGN_IN_CODE, signInMessage(this.options.name));
        return false;
      }
      await discard(response);
      if (!response.ok) {
        this.fail(message, write, FAILURE_CODE, `${this.options.name} answered ${statusLine(response)}.`);
        return false;
      }
      return true;
    } catch (cause) {
      if (this.closed) return false;
      this.fail(message, write, FAILURE_CODE, `${this.options.name} could not be reached: ${reason(cause)}.`);
      return false;
    }
  }

  /** Requests get a JSON-RPC error so the agent is not left waiting; anything else is only logged. */
  private fail(message: unknown, write: boolean, code: number, text: string): void {
    this.log(text);
    if (!write) return;
    for (const id of requestIds(message)) this.write({ jsonrpc: "2.0", id, error: { code, message: text } });
  }
}

/** Parses a server-sent event stream as it arrives. */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent, void, undefined> {
  const reader = body.getReader();
  const cancel = () => {
    reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let event = "";
  let id: string | undefined;
  const take = (line: string): SseEvent | undefined => {
    if (line === "") {
      if (data.length === 0) {
        event = "";
        return undefined;
      }
      const dispatched: SseEvent = { event: event || "message", data: data.join("\n"), ...(id ? { id } : {}) };
      data = [];
      event = "";
      return dispatched;
    }
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id" && !value.includes("\0")) id = value;
    return undefined;
  };
  try {
    if (signal?.aborted) return;
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      for (;;) {
        const match = /\r\n|\r|\n/u.exec(buffer);
        if (!match) break;
        // A CR at the very end may be the first half of a CRLF split across chunks.
        if (!done && match[0] === "\r" && match.index === buffer.length - 1) break;
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const dispatched = take(line);
        if (dispatched) yield dispatched;
      }
      if (done) break;
    }
    // Lenient with servers that end the stream without the final blank line.
    const last = take(buffer) ?? take("");
    if (last) yield last;
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export function signInMessage(name: string): string {
  return `${name} needs you to sign in. Open ZLI Settings, then Integrations, and sign in again.`;
}

function isObject(value: unknown): value is Message {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequest(value: unknown): value is Message & { id: JsonRpcId; method: string } {
  return (
    isObject(value) &&
    typeof value.method === "string" &&
    (typeof value.id === "string" || typeof value.id === "number")
  );
}

function isInitialize(value: unknown): value is Message {
  return isRequest(value) && value.method === "initialize";
}

function isInitializedNotification(value: unknown): boolean {
  return isObject(value) && value.method === "notifications/initialized" && value.id === undefined;
}

function requestIds(message: unknown): JsonRpcId[] {
  const items = Array.isArray(message) ? message : [message];
  return items.filter(isRequest).map((item) => item.id);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function statusLine(response: Response): string {
  return response.statusText ? `${response.status} ${response.statusText}` : String(response.status);
}

function reason(cause: unknown): string {
  const inner = cause instanceof Error && cause.cause instanceof Error ? cause.cause : cause;
  const text = inner instanceof Error ? inner.message : String(inner);
  return text.replace(/\.+$/u, "");
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}
