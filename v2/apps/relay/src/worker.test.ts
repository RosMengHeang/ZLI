import { request as httpRequest } from "node:http";
import { fileURLToPath, URL as NodeURL } from "node:url";

import { roomIdFromSecret, toBase64Url } from "@zli-v2/remote-protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { unstable_startWorker } from "wrangler";

/*
 * Runs the real Worker and Durable Object in workerd, so the shell is checked against the runtime
 * and not only against RelayRoom's fakes.
 */

type Worker = Awaited<ReturnType<typeof unstable_startWorker>>;

let worker: Worker;
// Kept as a string: Node's URL type and the Workers URL type in this tsconfig do not mix.
let base: string;

const PING = JSON.stringify({ type: "ping" });
const PONG = JSON.stringify({ type: "pong" });

// Short timers so the timer-driven closes can be checked in real time.
const DIAL_MS = 1_000;
const IDLE_MS = 1_500;

beforeAll(async () => {
  worker = await unstable_startWorker({
    config: fileURLToPath(new URL("../wrangler.toml", import.meta.url).href),
    bindings: {
      RELAY_TEST_LIMITS: {
        type: "plain_text",
        value: JSON.stringify({ dialTimeoutMs: DIAL_MS, idleTimeoutMs: IDLE_MS }),
      },
    },
    dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist: false },
  });
  await worker.ready;
  base = (await worker.url).href;
}, 120_000);

afterAll(async () => {
  await worker?.dispose();
});

/*
 * Every request counts against the 30-a-minute limit for its address, so each test gets its own
 * address and the tests never share a bucket.
 */
let address = "";
let nextAddress = 1;
beforeEach(() => {
  address = `192.0.2.${nextAddress}`;
  nextAddress += 1;
});

function socketUrl(path: string, at: string): string {
  const url = new URL(path, at);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/** A WebSocket that records what it receives and how it closed. */
function connect(path: string, at: string = base) {
  // Node's WebSocket takes headers in place of protocols; the Workers types here do not know that.
  const init = { headers: { "CF-Connecting-IP": address } } as unknown as string[];
  const ws = new WebSocket(socketUrl(path, at), init);
  ws.binaryType = "arraybuffer";
  const messages: Array<string | ArrayBuffer> = [];
  const waiters: Array<() => void> = [];
  // The runtime answers a host's ping itself; those replies are counted apart so they never pass for room messages.
  const pongs = { count: 0 };
  ws.addEventListener("message", (event) => {
    if (event.data === PONG) {
      pongs.count += 1;
      return;
    }
    messages.push(event.data);
    for (const wake of waiters.splice(0)) wake();
  });
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error(`could not open ${path}`)), { once: true });
  });
  let reason = "";
  const closed = new Promise<number>((resolve) => {
    ws.addEventListener(
      "close",
      (event) => {
        reason = event.reason;
        resolve(event.code);
      },
      { once: true },
    );
  });
  const next = async (count = 1): Promise<Array<string | ArrayBuffer>> => {
    while (messages.length < count) await new Promise<void>((resolve) => waiters.push(resolve));
    return messages.slice(0, count);
  };
  return { ws, opened, closed, next, messages, pongs, closeReason: () => reason };
}

function within<T>(promise: Promise<T>, ms = 5_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)),
  ]);
}

/** The status of a hand-built HTTP request; fetch refuses some of the header shapes tested here. */
function rawStatus(
  path: string,
  method: string,
  upgrade: string | null,
  extra: Record<string, string> = {},
): Promise<number> {
  const headers: Record<string, string> = { "CF-Connecting-IP": address, ...extra };
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
async function dialPhone(room: string, control: ReturnType<typeof connect>, at: string = base) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const phone = connect(`/v1/phone/${room}`, at);
    const heard = control.next(1).then(() => "open" as const);
    const outcome = await within(Promise.race([heard, phone.closed.then(() => "closed" as const)]));
    if (outcome === "open") return phone;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the host never heard about a phone");
}

describe("relay worker", () => {
  it("closes a phone with 4404 when no desktop holds the room", async () => {
    const room = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    const phone = connect(`/v1/phone/${room}`);
    expect(await within(phone.closed)).toBe(4404);
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

  it("passes the desktop's 4003 close on to the phone, and turns 3000 into 1000", async () => {
    const control = await claimedControl();
    for (const [sent, expected] of [
      [4003, 4003],
      // A browser-style client may not send 1011; any code outside 4000-4999 takes the same path.
      [3000, 1000],
    ] as const) {
      const phone = await dialPhone(control.room, control);
      const open = JSON.parse(String(control.messages.splice(0, 1)[0])) as { session: string };
      await within(phone.opened);
      phone.ws.send("hello desktop");
      const sessionHost = connect(`/v1/host/${control.room}/${open.session}`);
      await within(sessionHost.next(1));
      sessionHost.ws.send("hi");
      await within(phone.next(1));
      sessionHost.ws.close(sent, "This phone is not paired.");
      expect(await within(phone.closed)).toBe(expected);
    }
    control.ws.close(1000);
  });

  it("answers 429 once an address passes 30 requests a minute", async () => {
    const limited = { "CF-Connecting-IP": "198.51.100.30" };
    for (let i = 0; i < 30; i += 1) expect(await rawStatus("/", "GET", null, limited)).toBe(404);
    expect(await rawStatus("/", "GET", null, limited)).toBe(429);
    const room = toBase64Url(new Uint8Array(16));
    expect(await rawStatus(`/v1/phone/${room}`, "GET", "websocket", limited)).toBe(429);
    expect(await rawStatus("/", "GET", null, { "CF-Connecting-IP": "198.51.100.31" })).toBe(404);
  });

  it("closes a phone that sent its first frame with 4404 when the desktop never dials", async () => {
    const control = await claimedControl();
    const phone = await dialPhone(control.room, control);
    await within(phone.opened);
    phone.ws.send("hello desktop");
    const started = Date.now();
    expect(await within(phone.closed)).toBe(4404);
    expect(Date.now() - started).toBeGreaterThanOrEqual(DIAL_MS / 2);
    control.ws.close(1000);
  });

  /*
   * workerd holds back a close the room issues later on a hibernatable socket whose client has never
   * sent anything, until the object next hibernates (about ten seconds after its last event). Real
   * desktops and phones always send first, so this only slows down the notice to a silent client.
   * The room frees the slot the moment the deadline passes, which is what keeps it safe.
   */
  it("frees a silent control socket's slot at its claim deadline, and closes it with 1008", async () => {
    const room = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    const first = connect(`/v1/host/${room}`);
    await within(first.opened);
    const second = connect(`/v1/host/${room}`);
    await within(second.opened);
    await new Promise((resolve) => setTimeout(resolve, DIAL_MS + 500));
    // The room let go of both at the deadline, so two newcomers fit without pushing anyone out.
    const third = connect(`/v1/host/${room}`);
    const fourth = connect(`/v1/host/${room}`);
    await within(Promise.all([third.opened, fourth.opened]));
    expect(await within(first.closed, 25_000)).toBe(1008);
    expect(await within(second.closed, 5_000)).toBe(1008);
  }, 45_000);

  it("closes the oldest unclaimed control socket to admit a newcomer, which can then claim", async () => {
    const secretBytes = crypto.getRandomValues(new Uint8Array(32));
    const room = roomIdFromSecret(secretBytes);
    const squatters = [connect(`/v1/host/${room}`), connect(`/v1/host/${room}`)];
    await within(Promise.all(squatters.map((squatter) => squatter.opened)));
    const desktop = connect(`/v1/host/${room}`);
    await within(desktop.opened);
    desktop.ws.send(JSON.stringify({ type: "claim", secret: toBase64Url(secretBytes) }));
    const phone = await dialPhone(room, desktop);
    await within(phone.opened);
    desktop.ws.close(1000);
  });

  it("closes a joined session that goes quiet for the idle timeout", async () => {
    const control = await claimedControl();
    const phone = await dialPhone(control.room, control);
    const open = JSON.parse(String((await control.next(1))[0])) as { session: string };
    await within(phone.opened);
    phone.ws.send("hello desktop");
    const sessionHost = connect(`/v1/host/${control.room}/${open.session}`);
    await within(sessionHost.next(1));
    sessionHost.ws.send("hi");
    await within(phone.next(1));
    const started = Date.now();
    expect(await within(phone.closed)).toBe(1000);
    expect(await within(sessionHost.closed)).toBe(1000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(IDLE_MS / 2);
    control.ws.close(1000);
  });

  it("answers a host's pings without the room, and keeps the room online on them alone", async () => {
    const control = await claimedControl();
    const end = Date.now() + IDLE_MS * 3;
    while (Date.now() < end) {
      control.ws.send(PING);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    expect(control.pongs.count).toBeGreaterThanOrEqual(10);
    // Past twice the idle limit with only pings, the room still has its desktop.
    const phone = await dialPhone(control.room, control);
    await within(phone.opened);
    control.ws.close(1000);
  }, 20_000);

  it("takes the room offline when the desktop stops sending heartbeats", async () => {
    const control = await claimedControl();
    expect(await within(control.closed)).toBe(1013);
    const phone = connect(`/v1/phone/${control.room}`);
    expect(await within(phone.closed)).toBe(4404);
  });
});

/** A control socket that has claimed a fresh room. */
async function claimedControl(at: string = base) {
  const secretBytes = crypto.getRandomValues(new Uint8Array(32));
  const room = roomIdFromSecret(secretBytes);
  const control = connect(`/v1/host/${room}`, at);
  await within(control.opened);
  control.ws.send(JSON.stringify({ type: "claim", secret: toBase64Url(secretBytes) }));
  return { ...control, room };
}

/** A separate worker with a tiny relay-wide daily cap. */
describe("relay worker with a daily cap", () => {
  let capped: Worker;
  let cappedBase: string;
  const CAP = 50;

  beforeAll(async () => {
    capped = await unstable_startWorker({
      config: fileURLToPath(new URL("../wrangler.toml", import.meta.url).href),
      bindings: { RELAY_DAILY_FRAMES: { type: "plain_text", value: String(CAP) } },
      dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist: false },
    });
    await capped.ready;
    cappedBase = (await capped.url).href;
  }, 120_000);

  afterAll(async () => {
    await capped?.dispose();
  });

  it("refuses new sessions with 1013 once the relay has forwarded its day's frames", async () => {
    const control = await claimedControl(cappedBase);
    const phone = await dialPhone(control.room, control, cappedBase);
    const open = JSON.parse(String((await control.next(1))[0])) as { session: string };
    await within(phone.opened);
    phone.ws.send("hello desktop");
    const sessionHost = connect(`/v1/host/${control.room}/${open.session}`, cappedBase);
    await within(sessionHost.next(1));
    for (let index = 0; index < CAP + 30; index += 1) sessionHost.ws.send(`frame ${index}`);
    await within(phone.next(CAP + 30));

    // Rooms report their counts in batches, so the next phone may take a moment to see the total.
    let refused: ReturnType<typeof connect> | undefined;
    for (let attempt = 0; attempt < 10 && !refused; attempt += 1) {
      const late = connect(`/v1/phone/${control.room}`, cappedBase);
      late.opened.catch(() => undefined);
      const outcome = await within(
        Promise.race([late.closed.then(() => "closed" as const), control.next(2).then(() => "open" as const)]),
      );
      if (outcome === "closed" && late.closeReason() === "Relay daily limit reached.") refused = late;
      else {
        late.ws.close(1000);
        control.messages.splice(1);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    expect(refused).toBeDefined();
    expect(await within(refused?.closed ?? Promise.resolve(0))).toBe(1013);
    control.ws.close(1000);
  }, 30_000);
});

/*
 * A separate worker with long timers, so the room can sit idle long enough for workerd to
 * hibernate it without any deadline firing first.
 */
describe("relay worker across hibernation", () => {
  let sleepy: Worker;
  let sleepyBase: string;

  beforeAll(async () => {
    sleepy = await unstable_startWorker({
      config: fileURLToPath(new URL("../wrangler.toml", import.meta.url).href),
      bindings: {
        RELAY_TEST_LIMITS: {
          type: "plain_text",
          value: JSON.stringify({ dialTimeoutMs: 60_000, idleTimeoutMs: 120_000 }),
        },
      },
      dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist: false },
    });
    await sleepy.ready;
    sleepyBase = (await sleepy.url).href;
  }, 120_000);

  afterAll(async () => {
    await sleepy?.dispose();
  });

  it("keeps the handshake frame cap on an unanswered phone after a wake", async () => {
    const control = await claimedControl(sleepyBase);
    const phone = await dialPhone(control.room, control, sleepyBase);
    const open = JSON.parse(String((await control.next(1))[0])) as { session: string };
    await within(phone.opened);
    const sessionHost = connect(`/v1/host/${control.room}/${open.session}`, sleepyBase);
    await within(sessionHost.opened);
    for (let i = 0; i < 8; i += 1) phone.ws.send(`frame ${i}`);
    await within(sessionHost.next(8));

    // A witness: the room pushes out a silent unclaimed socket, and workerd only delivers that
    // close when the object hibernates. Seeing it proves the next frame lands on a rebuilt room.
    const witness = connect(`/v1/host/${control.room}`, sleepyBase);
    await within(witness.opened);
    const others = [connect(`/v1/host/${control.room}`, sleepyBase), connect(`/v1/host/${control.room}`, sleepyBase)];
    await within(Promise.all(others.map((other) => other.opened)));
    expect(await within(witness.closed, 30_000)).toBe(1013);

    phone.ws.send("one too many");
    expect(await within(phone.closed)).toBe(1008);
    // The session host never sent anything, so its close waits for the next hibernation.
    control.ws.close(1000);
  }, 60_000);
});
