import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type AppsCall, AppsProxy, type AppsVerdict, keyScrubber } from "./AppsProxy.js";
import { ConnectedApps } from "./ConnectedApps.js";

const proxies: AppsProxy[] = [];
const folders: string[] = [];
afterEach(async () => {
  for (const proxy of proxies.splice(0)) await proxy.stop();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

type Seen = { url: string; headers: Record<string, string>; body: string };

async function startProxy(decide?: (call: AppsCall) => Promise<AppsVerdict>) {
  const seen: Seen[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    seen.push({
      url,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: init.body ? Buffer.from(init.body as Uint8Array).toString() : "",
    });
    return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
      status: 200,
      headers: { "content-type": "application/json", "mcp-session-id": "s1", "set-cookie": "x=1" },
    });
  }) as typeof globalThis.fetch;
  const proxy = new AppsProxy({
    upstream: () => ({ url: "https://connect.composio.dev/mcp", headers: { "x-api": "ck_secret" } }),
    fetch,
    ...(decide ? { decide } : {}),
  });
  proxies.push(proxy);
  await proxy.start();
  return { proxy, seen };
}

/** A raw request, so the Host and Origin headers are exactly what a caller sends. */
function send(
  url: string,
  headers: Record<string, string>,
  body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list" },
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
      },
    );
    req.on("error", reject);
    req.end(typeof body === "string" ? body : JSON.stringify(body));
  });
}

const call = (name: string, args: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id: 7,
  method: "tools/call",
  params: { name, arguments: args },
});
const sendEmail = call("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: {} }] });
const fetchEmails = call("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS" }] });

describe("AppsProxy", () => {
  it("adds the key on the way out, so the agent only ever holds a local token", async () => {
    const { proxy, seen } = await startProxy();
    const endpoint = proxy.endpoint("wt-1");
    if (!endpoint) throw new Error("not started");
    expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/composio$/u);
    expect(JSON.stringify(endpoint)).not.toContain("ck_secret");
    const reply = await send(endpoint.url, { ...endpoint.headers, "mcp-session-id": "s1", cookie: "private=1" });
    expect(reply.status).toBe(200);
    expect(reply.headers["mcp-session-id"]).toBe("s1");
    // Only MCP's own headers come back, and only those go out, with the key added there.
    expect(reply.headers["set-cookie"]).toBeUndefined();
    expect(seen[0]?.url).toBe("https://connect.composio.dev/mcp");
    expect(seen[0]?.headers["x-api"]).toBe("ck_secret");
    expect(seen[0]?.headers["mcp-session-id"]).toBe("s1");
    expect(seen[0]?.headers.authorization).toBeUndefined();
    expect(seen[0]?.headers.cookie).toBeUndefined();
    // Each worktree gets its own token, the same one for as long as ZLI runs.
    expect(proxy.endpoint("wt-1")).toEqual(endpoint);
    expect(proxy.endpoint("wt-2")?.headers.Authorization).not.toBe(endpoint.headers.Authorization);
  });

  it("turns away a missing or wrong token, a browser page, and another host name", async () => {
    const { proxy, seen } = await startProxy();
    const endpoint = proxy.endpoint("wt-1");
    if (!endpoint) throw new Error("not started");
    expect((await send(endpoint.url, {})).status).toBe(401);
    expect((await send(endpoint.url, { Authorization: `Bearer ${"0".repeat(64)}` })).status).toBe(401);
    expect((await send(endpoint.url, { ...endpoint.headers, Origin: "https://evil.example" })).status).toBe(404);
    expect((await send(endpoint.url, { ...endpoint.headers, Host: "evil.example" })).status).toBe(404);
    expect(seen).toEqual([]);
  });

  it("lets reads through, and holds anything that changes something for the person's answer", async () => {
    const asked: AppsCall[] = [];
    let answer: AppsVerdict = { allowed: true };
    const { proxy, seen } = await startProxy(async (held) => {
      asked.push(held);
      return answer;
    });
    const endpoint = proxy.endpoint("wt-1");
    if (!endpoint) throw new Error("not started");
    await send(endpoint.url, endpoint.headers, fetchEmails);
    expect(asked).toEqual([]);
    expect(seen).toHaveLength(1);

    await send(endpoint.url, endpoint.headers, sendEmail);
    expect(asked).toEqual([expect.objectContaining({ worktreeId: "wt-1", tool: "COMPOSIO_MULTI_EXECUTE_TOOL" })]);
    expect(seen).toHaveLength(2);

    answer = { allowed: false, reason: "The person said no." };
    const refused = JSON.parse((await send(endpoint.url, endpoint.headers, sendEmail)).body);
    expect(refused).toMatchObject({ id: 7, result: { isError: true, content: [{ text: "The person said no." }] } });
    expect(seen).toHaveLength(2);
  });

  it("refuses changes from a caller it cannot place, batches with a call, and calls it cannot read", async () => {
    const { proxy, seen } = await startProxy(async () => ({ allowed: true }));
    const shared = proxy.endpoint();
    const own = proxy.endpoint("wt-1");
    if (!shared || !own) throw new Error("not started");
    // The shared token reads, but cannot change anything: there is no chat to ask in.
    await send(shared.url, shared.headers, fetchEmails);
    expect(seen).toHaveLength(1);
    const unplaced = JSON.parse((await send(shared.url, shared.headers, sendEmail)).body);
    expect(unplaced.result.isError).toBe(true);
    const batch = JSON.parse((await send(own.url, own.headers, [fetchEmails, sendEmail])).body);
    expect(batch.result.isError).toBe(true);
    const garbled = JSON.parse((await send(own.url, own.headers, "{not json")).body);
    expect(garbled.error).toBeDefined();
    expect(seen).toHaveLength(1);
  });

  it("makes ConnectedApps hand agents the local address, never the key", async () => {
    const folder = mkdtempSync(join(tmpdir(), "zli-proxy-"));
    folders.push(folder);
    const path = join(folder, "connected-apps.json");
    writeFileSync(path, JSON.stringify({ via: "connect", apiKey: "ck_secret_key" }));
    let apps: ConnectedApps | undefined;
    const proxy = new AppsProxy({ upstream: () => apps?.upstream() });
    proxies.push(proxy);
    await proxy.start();
    apps = new ConnectedApps({ path, proxy });
    await apps.load();
    const server = apps.server("wt-1");
    expect(server).toMatchObject({ url: proxy.endpoint("wt-1")?.url, headers: proxy.endpoint("wt-1")?.headers });
    expect(JSON.stringify(server)).not.toContain("ck_secret_key");
    expect(apps.upstream()?.headers).toEqual({ "x-consumer-api-key": "ck_secret_key" });
  });

  it("gives agents no connected apps, never the key, when the relay could not start", async () => {
    const folder = mkdtempSync(join(tmpdir(), "zli-proxy-"));
    folders.push(folder);
    const path = join(folder, "connected-apps.json");
    writeFileSync(path, JSON.stringify({ via: "connect", apiKey: "ck_secret_key" }));
    // Never started: no port, so no local address to hand out.
    const proxy = new AppsProxy({ upstream: () => undefined });
    const apps = new ConnectedApps({ path, proxy });
    await apps.load();
    expect(apps.server("wt-1")).toBeUndefined();
    expect(apps.server()).toBeUndefined();
  });

  it("answers a held call at once without reaching Composio, then runs it for the person with the key", async () => {
    const { proxy, seen } = await startProxy(async () => ({ held: true, reason: "On a card for the person." }));
    const endpoint = proxy.endpoint("wt-1");
    const reply = await send(
      endpoint?.url ?? "",
      { ...endpoint?.headers, host: new URL(endpoint?.url ?? "").host },
      sendEmail,
    );
    expect(JSON.parse(reply.body)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { content: [{ type: "text", text: "On a card for the person." }] },
    });
    expect(seen).toEqual([]);
    expect(await proxy.run("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [] })).toMatchObject({ ok: true });
    expect(seen[0]?.headers["x-api"]).toBe("ck_secret");
    expect(JSON.parse(seen[0]?.body ?? "{}")).toMatchObject({
      method: "tools/call",
      params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL" },
    });
  });

  it("cuts the key out of what Composio sends back to the agent", async () => {
    const key = "ak_live_0123456789";
    // Composio echoes the request in an error, streamed in pieces that split the key.
    const pieces = ['data: {"error":"bad header x-api-key: ak_live_', "0123", '456789, retry"}\n'];
    const fetch = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const piece of pieces) controller.enqueue(new TextEncoder().encode(piece));
            controller.close();
          },
        }),
        { status: 400, headers: { "content-type": "text/event-stream" } },
      )) as typeof globalThis.fetch;
    const proxy = new AppsProxy({
      upstream: () => ({ url: "https://backend.composio.dev/mcp", headers: { "x-api-key": key } }),
      fetch,
    });
    proxies.push(proxy);
    await proxy.start();
    const endpoint = proxy.endpoint("wt-1");
    if (!endpoint) throw new Error("not started");
    const reply = await send(endpoint.url, endpoint.headers);
    expect(reply.status).toBe(400);
    expect(reply.body).not.toContain("0123456789");
    expect(reply.body).toContain("x-api-key: [key], retry");
  });
});

describe("keyScrubber", () => {
  it("finds a key split across any two chunks, and leaves other text as it was", async () => {
    const key = "ck_abcdefgh";
    const text = `start ${key} middle ${key}${key} end`;
    for (let cut = 0; cut <= text.length; cut += 1) {
      const scrubber = keyScrubber([key]);
      const out: Buffer[] = [];
      scrubber.on("data", (chunk: Buffer) => out.push(chunk));
      const ended = new Promise((resolve) => scrubber.on("end", resolve));
      scrubber.write(Buffer.from(text.slice(0, cut)));
      scrubber.end(Buffer.from(text.slice(cut)));
      await ended;
      expect(Buffer.concat(out).toString()).toBe("start [key] middle [key][key] end");
    }
  });
});
