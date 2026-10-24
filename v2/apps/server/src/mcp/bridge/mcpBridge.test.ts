import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { readSse, runMcpBridge, signInMessage } from "./mcpBridge.js";

const URL_ = "https://mcp.example.com/mcp";
const INIT = {
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agent", version: "1" } },
};
const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };
const initResult = (id: unknown = 0) => ({
  jsonrpc: "2.0",
  id,
  result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "remote", version: "1" } },
});

type Call = { url: string; method: string; headers: Headers; body: unknown; signal: AbortSignal | undefined };
type Handler = (call: Call) => Response | Promise<Response>;

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function status(code: number, statusText = ""): Response {
  return new Response(null, { status: code, statusText });
}

/** A stream the test feeds by hand. */
function feed() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  return {
    stream,
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
  };
}

function sse(stream: ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Response {
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", ...headers } });
}

function never(signal: AbortSignal | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
  });
}

/** Answers initialize with a session, accepts notifications, refuses the GET stream, and passes the rest on. */
function server(rest: Handler = () => status(500)): Handler {
  return (call) => {
    if (call.method === "GET") return status(405);
    if (call.method === "DELETE") return status(200);
    const body = call.body as { method?: string; id?: unknown };
    if (body.method === "initialize") return json(initResult(body.id), { headers: { "mcp-session-id": "session-1" } });
    if (body.id === undefined) return status(202);
    return rest(call);
  };
}

function harness(
  handler: Handler,
  options: {
    token?: (force: boolean) => string | undefined;
    headers?: Record<string, string>;
    hiddenTools?: string[];
    onSignInRejected?: (token: string) => void;
  } = {},
) {
  const input = new PassThrough();
  const output: unknown[] = [];
  const calls: Call[] = [];
  const logs: string[] = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  const getToken = vi.fn(async (force: boolean) => options.token?.(force));
  const done = runMcpBridge({
    url: URL_,
    headers: options.headers ?? {},
    getToken,
    name: "Linear",
    fetch: fakeFetch,
    input,
    output: { write: (line: string) => output.push(JSON.parse(line)) },
    log: (message) => logs.push(message),
    ...(options.hiddenTools ? { hiddenTools: options.hiddenTools } : {}),
    ...(options.onSignInRejected ? { onSignInRejected: options.onSignInRejected } : {}),
  });
  return {
    input,
    output,
    calls,
    logs,
    getToken,
    send: (...messages: unknown[]) => {
      for (const message of messages) input.write(`${JSON.stringify(message)}\n`);
    },
    waitForOutput: (count: number) => vi.waitFor(() => expect(output.length).toBeGreaterThanOrEqual(count)),
    posts: () => calls.filter((call) => call.method === "POST"),
    end: async () => {
      input.end();
      await done;
    },
  };
}

describe("runMcpBridge over streamable HTTP", () => {
  it("posts each message and writes JSON replies, skipping blank and broken lines", async () => {
    const bridge = harness(
      server((call) => {
        const body = call.body as { id: number };
        return json([{ jsonrpc: "2.0", id: body.id, result: { tools: [] } }]);
      }),
    );
    bridge.input.write("\n   \nnot json\n");
    bridge.send(INIT, INITIALIZED, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    await bridge.waitForOutput(2);
    expect(bridge.output).toEqual([initResult(), { jsonrpc: "2.0", id: 1, result: { tools: [] } }]);
    const [init] = bridge.posts();
    expect(init?.url).toBe(URL_);
    expect(init?.headers.get("content-type")).toBe("application/json");
    expect(init?.headers.get("accept")).toBe("application/json, text/event-stream");
    expect(bridge.logs.some((line) => line.includes("not JSON"))).toBe(true);
    await bridge.end();
  });

  it("sends the session id and protocol version after initialize, but not on initialize", async () => {
    const bridge = harness(server(() => json({ jsonrpc: "2.0", id: 1, result: {} })));
    bridge.send(INIT, INITIALIZED, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    await bridge.waitForOutput(2);
    const [init, initialized, list] = bridge.posts();
    expect(init?.headers.get("mcp-session-id")).toBeNull();
    expect(init?.headers.get("mcp-protocol-version")).toBeNull();
    for (const call of [initialized, list]) {
      expect(call?.headers.get("mcp-session-id")).toBe("session-1");
      expect(call?.headers.get("mcp-protocol-version")).toBe("2025-06-18");
    }
    await bridge.end();
  });

  it("writes every event of an SSE reply, even when chunks split lines", async () => {
    const body = feed();
    const bridge = harness(server(() => sse(body.stream)));
    bridge.send(INIT, INITIALIZED, { jsonrpc: "2.0", id: 1, method: "tools/call" });
    await bridge.waitForOutput(1);
    await vi.waitFor(() => expect(bridge.posts()).toHaveLength(3));
    body.push(': keep-alive\r\nid: 1\r\nevent: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/');
    body.push('progress","params":{"progress":1}}\r');
    body.push("\n\r\n");
    await bridge.waitForOutput(2);
    expect(bridge.output[1]).toEqual({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } });
    body.push('data: {"jsonrpc":"2.0",\ndata: "id":1,"result":{"ok":true}}\n\n');
    body.close();
    await bridge.waitForOutput(3);
    expect(bridge.output[2]).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    await bridge.end();
  });

  it("answers a later request while an earlier one is still running", async () => {
    let finishSlow!: (response: Response) => void;
    const bridge = harness(
      server((call) => {
        const body = call.body as { id: number };
        if (body.id === 1) return new Promise<Response>((resolve) => (finishSlow = resolve));
        return json({ jsonrpc: "2.0", id: body.id, result: "fast" });
      }),
    );
    bridge.send(
      INIT,
      INITIALIZED,
      { jsonrpc: "2.0", id: 1, method: "tools/call" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    );
    await bridge.waitForOutput(2);
    expect(bridge.output[1]).toEqual({ jsonrpc: "2.0", id: 2, result: "fast" });
    finishSlow(json({ jsonrpc: "2.0", id: 1, result: "slow" }));
    await bridge.waitForOutput(3);
    expect(bridge.output[2]).toEqual({ jsonrpc: "2.0", id: 1, result: "slow" });
    await bridge.end();
  });

  it("holds other messages until initialize has finished", async () => {
    let finishInit!: () => void;
    const bridge = harness((call) => {
      const body = call.body as { method?: string; id?: number };
      if (body?.method === "initialize") {
        return new Promise<Response>((resolve) => {
          finishInit = () => resolve(json(initResult(), { headers: { "mcp-session-id": "session-1" } }));
        });
      }
      if (call.method !== "POST") return status(405);
      return body.id === undefined ? status(202) : json({ jsonrpc: "2.0", id: body.id, result: {} });
    });
    bridge.send(INIT, INITIALIZED, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    await vi.waitFor(() => expect(bridge.posts()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bridge.posts()).toHaveLength(1);
    finishInit();
    await bridge.waitForOutput(2);
    expect(
      bridge
        .posts()
        .slice(1)
        .map((call) => call.headers.get("mcp-session-id")),
    ).toEqual(["session-1", "session-1"]);
    await bridge.end();
  });

  it("sends the saved token, overriding a static Authorization header, and no empty one", async () => {
    const signedIn = harness(server(), {
      token: () => "token-1",
      headers: { Authorization: "Bearer static", "X-Team": "a" },
    });
    signedIn.send(INIT);
    await signedIn.waitForOutput(1);
    expect(signedIn.posts()[0]?.headers.get("authorization")).toBe("Bearer token-1");
    expect(signedIn.posts()[0]?.headers.get("x-team")).toBe("a");
    expect(signedIn.getToken).toHaveBeenCalledWith(false);
    await signedIn.end();

    const staticOnly = harness(server(), { headers: { Authorization: "Bearer static" } });
    staticOnly.send(INIT);
    await staticOnly.waitForOutput(1);
    expect(staticOnly.posts()[0]?.headers.get("authorization")).toBe("Bearer static");
    await staticOnly.end();

    const none = harness(server());
    none.send(INIT);
    await none.waitForOutput(1);
    expect(none.posts()[0]?.headers.has("authorization")).toBe(false);
    await none.end();
  });

  it("refreshes the token once after a 401 and retries", async () => {
    const bridge = harness(
      (call) => {
        if (call.headers.get("authorization") !== "Bearer fresh") return status(401);
        return server()(call);
      },
      { token: (force) => (force ? "fresh" : "stale") },
    );
    bridge.send(INIT);
    await bridge.waitForOutput(1);
    expect(bridge.output).toEqual([initResult()]);
    expect(bridge.getToken).toHaveBeenCalledWith(true);
    expect(bridge.posts().map((call) => call.headers.get("authorization"))).toEqual(["Bearer stale", "Bearer fresh"]);
    await bridge.end();
  });

  it("asks the user to sign in when the server still refuses", async () => {
    const bridge = harness(() => status(401), { token: () => "stale" });
    bridge.send(INIT, INITIALIZED);
    await bridge.waitForOutput(1);
    expect(bridge.output[0]).toEqual({
      jsonrpc: "2.0",
      id: 0,
      error: { code: -32001, message: signInMessage("Linear") },
    });
    expect(signInMessage("Linear")).toBe(
      "Linear needs you to sign in. Open ZLI Settings, then Connectors or MCP servers, and sign in again.",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bridge.output).toHaveLength(1);
    expect(bridge.calls.some((call) => call.method === "GET")).toBe(false);
    await bridge.end();
  });

  it("asks the user to sign in when a 401 comes and there is no token", async () => {
    const bridge = harness(() => status(401));
    bridge.send(INIT);
    await bridge.waitForOutput(1);
    expect(bridge.output[0]).toMatchObject({ id: 0, error: { code: -32001 } });
    expect(bridge.posts()).toHaveLength(1);
    await bridge.end();
  });

  it("starts a new session when the old one expired and retries the request", async () => {
    let sessions = 0;
    const bridge = harness((call) => {
      if (call.method !== "POST") return status(call.method === "DELETE" ? 200 : 405);
      const body = call.body as { method?: string; id?: number };
      if (body.method === "initialize") {
        sessions += 1;
        return json(initResult(body.id), { headers: { "mcp-session-id": `session-${sessions}` } });
      }
      if (call.headers.get("mcp-session-id") !== "session-2") return status(404);
      return body.id === undefined ? status(202) : json({ jsonrpc: "2.0", id: body.id, result: "done" });
    });
    bridge.send(INIT);
    await bridge.waitForOutput(1);
    bridge.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    await bridge.waitForOutput(2);
    expect(bridge.output).toEqual([initResult(), { jsonrpc: "2.0", id: 1, result: "done" }]);
    expect(
      bridge.posts().map((call) => [(call.body as { method: string }).method, call.headers.get("mcp-session-id")]),
    ).toEqual([
      ["initialize", null],
      ["tools/list", "session-1"],
      ["initialize", null],
      ["notifications/initialized", "session-2"],
      ["tools/list", "session-2"],
    ]);
    await bridge.end();
  });

  it("answers requests with an error when the server cannot be reached or fails", async () => {
    const bridge = harness((call) => {
      const body = call.body as { id?: number };
      if (body.id === 1) return status(500, "Internal Server Error");
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:443") });
    });
    bridge.send(INIT, { jsonrpc: "2.0", id: 1, method: "tools/list" }, INITIALIZED);
    await bridge.waitForOutput(2);
    expect(bridge.output).toEqual([
      {
        jsonrpc: "2.0",
        id: 0,
        error: { code: -32000, message: "Linear could not be reached: connect ECONNREFUSED 127.0.0.1:443." },
      },
      { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Linear answered 500 Internal Server Error." } },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bridge.output).toHaveLength(2);
    await bridge.end();
  });

  it("reads server messages from the GET stream after initialized", async () => {
    const stream = feed();
    const bridge = harness((call) => {
      if (call.method === "GET") return sse(stream.stream);
      return server()(call);
    });
    bridge.send(INIT, INITIALIZED);
    await vi.waitFor(() => expect(bridge.calls.some((call) => call.method === "GET")).toBe(true));
    const get = bridge.calls.find((call) => call.method === "GET");
    expect(get?.headers.get("accept")).toBe("text/event-stream");
    expect(get?.headers.get("mcp-session-id")).toBe("session-1");
    stream.push('data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n');
    await bridge.waitForOutput(2);
    expect(bridge.output[1]).toEqual({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    await bridge.end();
    expect(get?.signal?.aborted).toBe(true);
  });

  it("ends the session with DELETE when input closes", async () => {
    const bridge = harness(server(), { token: () => "token-1" });
    bridge.send(INIT);
    await bridge.waitForOutput(1);
    await bridge.end();
    const del = bridge.calls.find((call) => call.method === "DELETE");
    expect(del?.url).toBe(URL_);
    expect(del?.headers.get("mcp-session-id")).toBe("session-1");
    expect(del?.headers.get("authorization")).toBe("Bearer token-1");
  });

  it("aborts a running request on shutdown and still resolves", async () => {
    const bridge = harness(server((call) => never(call.signal)));
    bridge.send(INIT, { jsonrpc: "2.0", id: 1, method: "tools/call" });
    await vi.waitFor(() => expect(bridge.posts()).toHaveLength(2));
    await bridge.end();
    expect(bridge.posts()[1]?.signal?.aborted).toBe(true);
    expect(bridge.output).toHaveLength(1);
  });
});

describe("runMcpBridge over the older HTTP+SSE transport", () => {
  it("falls back when initialize gets 405 and posts to the endpoint the stream names", async () => {
    const stream = feed();
    const posted: unknown[] = [];
    const bridge = harness(
      (call) => {
        if (call.url === URL_ && call.method === "POST") return status(405);
        if (call.url === URL_ && call.method === "GET") return sse(stream.stream);
        posted.push(call.body);
        const body = call.body as { id?: number; method: string };
        if (body.id !== undefined) {
          const result =
            body.method === "initialize" ? initResult(body.id) : { jsonrpc: "2.0", id: body.id, result: {} };
          queueMicrotask(() => stream.push(`event: message\ndata: ${JSON.stringify(result)}\n\n`));
        }
        return status(202);
      },
      { token: () => "token-1" },
    );
    bridge.send(INIT);
    await vi.waitFor(() => expect(bridge.calls.some((call) => call.method === "GET")).toBe(true));
    stream.push("event: endpoint\ndata: /messages?sessionId=abc\n\n");
    await bridge.waitForOutput(1);
    bridge.send(INITIALIZED, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    await bridge.waitForOutput(2);
    expect(bridge.output).toEqual([initResult(), { jsonrpc: "2.0", id: 1, result: {} }]);
    const get = bridge.calls.find((call) => call.method === "GET");
    expect(get?.headers.get("accept")).toBe("text/event-stream");
    expect(get?.headers.get("authorization")).toBe("Bearer token-1");
    const legacyPosts = bridge.calls.filter((call) => call.url !== URL_);
    expect(legacyPosts.map((call) => call.url)).toEqual([
      "https://mcp.example.com/messages?sessionId=abc",
      "https://mcp.example.com/messages?sessionId=abc",
      "https://mcp.example.com/messages?sessionId=abc",
    ]);
    expect(posted).toEqual([INIT, INITIALIZED, { jsonrpc: "2.0", id: 1, method: "tools/list" }]);
    await bridge.end();
    expect(bridge.calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(get?.signal?.aborted).toBe(true);
  });
});

describe("readSse", () => {
  it("joins data lines, keeps event names, and skips comments", async () => {
    const body = feed();
    body.push(": hi\nevent: endpoint\ndata: /a\n\ndata: one\ndata: two\nid: 7\n\ndata");
    body.push(": tail");
    body.close();
    const events = [];
    for await (const event of readSse(body.stream)) events.push(event);
    expect(events).toEqual([
      { event: "endpoint", data: "/a" },
      { event: "message", data: "one\ntwo", id: "7" },
      { event: "message", data: "tail", id: "7" },
    ]);
  });
});

describe("runMcpBridge extras", () => {
  it("hides turned-off tools from lists and refuses calls to them without asking the server", async () => {
    const bridge = harness(
      server((call) => {
        const body = call.body as { id: number; method: string };
        return json({
          jsonrpc: "2.0",
          id: body.id,
          result: body.method === "tools/list" ? { tools: [{ name: "search" }, { name: "delete" }] } : { ok: true },
        });
      }),
      { hiddenTools: ["delete"] },
    );
    bridge.send(INIT, INITIALIZED, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    await bridge.waitForOutput(2);
    bridge.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "delete" } });
    await bridge.waitForOutput(3);
    expect(bridge.output.slice(1)).toEqual([
      { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "search" }] } },
      { jsonrpc: "2.0", id: 2, error: { code: -32602, message: "delete is turned off for Linear in ZLI." } },
    ]);
    expect(bridge.posts().some((call) => (call.body as { id?: number }).id === 2)).toBe(false);
    await bridge.end();
  });

  it("reports the token the server still turned down after a forced refresh", async () => {
    const rejected: string[] = [];
    const bridge = harness(() => status(401), {
      token: (force) => (force ? "fresh" : "stale"),
      onSignInRejected: (token) => {
        rejected.push(token);
      },
    });
    bridge.send(INIT);
    await bridge.waitForOutput(1);
    expect(rejected).toEqual(["fresh"]);
    await bridge.end();

    const none: string[] = [];
    const signedOut = harness(() => status(401), { onSignInRejected: (token) => void none.push(token) });
    signedOut.send(INIT);
    await signedOut.waitForOutput(1);
    expect(none).toEqual([]);
    await signedOut.end();
  });
});
