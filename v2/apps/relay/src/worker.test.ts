import { request as httpRequest } from "node:http";
import { URL as NodeURL, fileURLToPath } from "node:url";

import { roomIdFromSecret, toBase64Url } from "@zli-v2/remote-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_startWorker } from "wrangler";

/*
 * Runs the real Worker and Durable Object in workerd, so the shell is checked against the runtime
 * and not only against RelayRoom's fakes.
 */

type Worker = Awaited<ReturnType<typeof unstable_startWorker>>;

let worker: Worker;
// Kept as a string: Node's URL type and the Workers URL type in this tsconfig do not mix.
let base: string;

beforeAll(async () => {
  worker = await unstable_startWorker({
    config: fileURLToPath(new URL("../wrangler.toml", import.meta.url).href),
    dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist: false },
  });
  await worker.ready;
  base = (await worker.url).href;
}, 120_000);

afterAll(async () => {
  await worker?.dispose();
});

function socketUrl(path: string): string {
  const url = new URL(path, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/** A WebSocket that records what it receives and how it closed. */
function connect(path: string) {
  const ws = new WebSocket(socketUrl(path));
  ws.binaryType = "arraybuffer";
  const messages: Array<string | ArrayBuffer> = [];
  const waiters: Array<() => void> = [];
  ws.addEventListener("message", (event) => {
    messages.push(event.data);
    for (const wake of waiters.splice(0)) wake();
  });
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error(`could not open ${path}`)), { once: true });
  });
  const closed = new Promise<number>((resolve) => {
    ws.addEventListener("close", (event) => resolve(event.code), { once: true });
  });
  const next = async (count = 1): Promise<Array<string | ArrayBuffer>> => {
    while (messages.length < count) await new Promise<void>((resolve) => waiters.push(resolve));
    return messages.slice(0, count);
  };
  return { ws, opened, closed, next };
}

function within<T>(promise: Promise<T>, ms = 5_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)),
  ]);
}

/** The status of a hand-built HTTP request; fetch refuses some of the header shapes tested here. */
function rawStatus(path: string, method: string, upgrade: string | null): Promise<number> {
  const headers: Record<string, string> = {};
  if (upgrade) {
    Object.assign(headers, {
      Connection: "Upgrade",
      Upgrade: upgrade,
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
    });
  }
  return new Promise((resolve, reject) => {
    const request = httpRequest(new NodeURL(path, base), { method, headers });
    request.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 0);
    });
    request.on("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", reject);
    request.end();
  });
}

/*
 * The claim travels on the control socket and the phone on its own request, so the phone can reach
 * the room before the claim is read. Retry until the host hears about one.
 */
async function dialPhone(room: string, control: ReturnType<typeof connect>) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const phone = connect(`/v1/phone/${room}`);
    const heard = control.next(1).then(() => "open" as const);
    const outcome = await within(Promise.race([heard, phone.closed.then(() => "closed" as const)]));
    if (outcome === "open") return phone;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the host never heard about a phone");
}

describe("relay worker", () => {
  it("closes a phone with 1013 when no desktop holds the room", async () => {
    const room = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    const phone = connect(`/v1/phone/${room}`);
    expect(await within(phone.closed)).toBe(1013);
  });

  it("answers 404 to plain requests, other methods, and malformed paths", async () => {
    const room = toBase64Url(new Uint8Array(16));
    expect(await rawStatus(`/v1/phone/${room}`, "GET", null)).toBe(404);
    expect(await rawStatus("/", "GET", null)).toBe(404);
    expect(await rawStatus("/v1/phone/nope", "GET", "websocket")).toBe(404);
    expect(await rawStatus(`/v1/phone/${room}/extra`, "GET", "websocket")).toBe(404);
    // workerd answers a POST upgrade with 400 before the Worker runs; either way it never upgrades.
    expect(await rawStatus(`/v1/phone/${room}`, "POST", "websocket")).not.toBe(101);
  });

  it("treats the Upgrade header without regard to case", async () => {
    const room = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    expect(await rawStatus(`/v1/phone/${room}`, "GET", "WebSocket")).toBe(101);
  });

  it("joins a phone and a desktop and forwards frames both ways", async () => {
    const secretBytes = crypto.getRandomValues(new Uint8Array(32));
    const room = roomIdFromSecret(secretBytes);

    const control = connect(`/v1/host/${room}`);
    await within(control.opened);
    control.ws.send(JSON.stringify({ type: "claim", secret: toBase64Url(secretBytes) }));
    control.ws.send(JSON.stringify({ type: "ping" }));

    const phone = await dialPhone(room, control);
    const open = JSON.parse(String((await control.next(1))[0])) as { type: string; session: string; client: string };
    expect(open.type).toBe("open");
    expect(open.client).toMatch(/^[0-9a-f]{32}$/u);

    await within(phone.opened);
    phone.ws.send("hello desktop");

    const sessionHost = connect(`/v1/host/${room}/${open.session}`);
    expect(await within(sessionHost.next(1))).toEqual(["hello desktop"]);

    sessionHost.ws.send(new Uint8Array([1, 2, 3]));
    const [reply] = await within(phone.next(1));
    expect(new Uint8Array(reply as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));

    phone.ws.close(1000);
    expect(await within(sessionHost.closed)).toBe(1000);
    control.ws.close(1000);
  });
});
