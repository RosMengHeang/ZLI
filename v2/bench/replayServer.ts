import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * A stand-in for the Anthropic Messages API, so the real `claude` CLI runs without a model or an account.
 * ADEMark measures speed the same way: a replay server takes the model's place. Every request body is kept,
 * which is how the benchmark counts what an app sends for one message.
 */
export type RecordedRequest = {
  at: number;
  path: string;
  bytes: number;
  /** Characters of the system prompt, tool definitions, and messages, the parts the model reads as tokens. */
  promptChars: number;
  model: string;
  toolCount: number;
  /** Which of ZLI's own tool servers the request names, to check agents reached them. */
  zliServers: string[];
  /** Text of the newest user message, to check which messages reached the model. */
  lastUserText: string;
};

export type ReplayServer = {
  url: string;
  requests: RecordedRequest[];
  /** How long each reply streams for. 0 answers at once; the load test sets minutes. */
  setStreamMs(ms: number): void;
  /** While blocked, open replies are cut and every new connection is dropped, as when the API is unreachable. */
  setBlocked(blocked: boolean): void;
  /** Connections dropped while blocked. */
  refused(): number;
  close(): Promise<void>;
};

export async function startReplayServer(): Promise<ReplayServer> {
  const requests: RecordedRequest[] = [];
  let streamMs = 0;
  let blocked = false;
  let refused = 0;
  const open = new Set<ServerResponse>();

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (blocked) {
      refused += 1;
      request.socket.destroy();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    // ZLI_BENCH_DUMP_DIR keeps every request body, to see what an app sends.
    if (process.env.ZLI_BENCH_DUMP_DIR) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(`${process.env.ZLI_BENCH_DUMP_DIR}/request-${Date.now()}-${requests.length}.json`, raw);
    }
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    if (request.method !== "POST" || !path.endsWith("/v1/messages")) {
      if (path.endsWith("/count_tokens")) return json(response, { input_tokens: Math.round(raw.length / 4) });
      return json(response, {});
    }
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // A body that does not parse is still counted by its size.
    }
    const promptChars =
      JSON.stringify(body.system ?? "").length +
      JSON.stringify(body.tools ?? []).length +
      JSON.stringify(body.messages ?? []).length;
    requests.push({
      at: Date.now(),
      path,
      bytes: raw.length,
      promptChars,
      model: typeof body.model === "string" ? body.model : "",
      toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
      zliServers: ["zli-browser", "zli-mobile", "zli__"].filter((name) => raw.includes(`mcp__${name}`)),
      lastUserText: lastUserText(body.messages),
    });
    const inputTokens = Math.round(promptChars / 4);
    if (body.stream !== true) {
      return json(response, {
        id: `msg_${requests.length}`,
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: "Hello." }],
        stop_reason: "end_turn",
        usage: { input_tokens: inputTokens, output_tokens: 2 },
      });
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    open.add(response);
    response.on("close", () => open.delete(response));
    const send = (event: string, data: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send("message_start", {
      type: "message_start",
      message: {
        id: `msg_${requests.length}`,
        type: "message",
        role: "assistant",
        model: body.model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: inputTokens, output_tokens: 1 },
      },
    });
    send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    const until = Date.now() + streamMs;
    let words = 0;
    do {
      send("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: words === 0 ? "Hello." : ` word${words}` },
      });
      words += 1;
      if (Date.now() >= until) break;
      // About 20 words a second, close to a model streaming prose.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (!response.destroyed && !blocked);
    if (response.destroyed || blocked) {
      response.destroy();
      return;
    }
    send("content_block_stop", { type: "content_block_stop", index: 0 });
    send("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: words },
    });
    send("message_stop", { type: "message_stop" });
    response.end();
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The replay server has no port.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    setStreamMs: (ms) => {
      streamMs = ms;
    },
    setBlocked: (value) => {
      blocked = value;
      if (value) for (const response of open) response.destroy();
    },
    refused: () => refused,
    close: async () => {
      for (const response of open) response.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function lastUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown };
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => part as { type?: unknown; text?: unknown })
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join(" ");
    }
  }
  return "";
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
