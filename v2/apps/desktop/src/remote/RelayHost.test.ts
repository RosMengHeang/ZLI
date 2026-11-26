import { EventEmitter } from "node:events";

import { type RelayRoute, toBase64Url } from "@zli-v2/remote-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import { PHONE_SOCKET_OPTIONS } from "./MobileGateway.js";
import { RelayHost, type RelayState } from "./RelayHost.js";

const route: RelayRoute = { url: "wss://relay.example.test", room: "AAAAAAAAAAAAAAAAAAAAAA" };
const session = "BBBBBBBBBBBBBBBBBBBBBQ";
const secret = new Uint8Array(32).fill(7);

/** Just enough of a ws socket for the host: events, send, close, terminate. */
class FakeSocket extends EventEmitter {
  readyState = 0;
  sent: string[] = [];
  closeCode: number | undefined;
  pings = 0;
  autoPong = true;
  deferClose = false;
  constructor(
    readonly url: string,
    readonly options: unknown,
  ) {
    super();
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number) {
    this.closeCode = code;
    this.readyState = 3;
    if (!this.deferClose) this.emit("close", code ?? 1005);
  }
  ping() {
    this.pings += 1;
    if (this.autoPong) this.emit("pong");
  }
  terminate() {
    this.readyState = 3;
    if (!this.deferClose) this.emit("close", 1006);
  }
  open() {
    this.readyState = 1;
    this.emit("open");
  }
  receive(message: unknown) {
    this.emit("message", Buffer.from(typeof message === "string" ? message : JSON.stringify(message)), false);
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.emit("close", code);
  }
}

describe("RelayHost", () => {
  let sockets: FakeSocket[];
  let states: RelayState[];
  let accepted: Array<{ socket: unknown; origin: unknown }>;
  let clock: number;
  let host: RelayHost;

  const control = () => sockets[0] as FakeSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    states = [];
    accepted = [];
    clock = Date.UTC(2026, 10, 26, 12, 0, 0);
    host = new RelayHost({
      route,
      secret,
      gateway: { accept: (socket, origin) => accepted.push({ socket, origin }) },
      createSocket: (url, options) => {
        const socket = new FakeSocket(url, options);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      onState: (state) => states.push(state),
      now: () => clock,
      random: () => 0.5,
    });
  });
  afterEach(() => {
    host.stop();
    vi.useRealTimers();
  });

  it("dials the host url with the phone socket options and claims the room on open", () => {
    host.start();
    expect(states).toEqual(["connecting"]);
    expect(control().url).toBe(`wss://relay.example.test/v1/host/${route.room}`);
    expect(control().options).toBe(PHONE_SOCKET_OPTIONS);
    control().open();
    expect(JSON.parse(control().sent[0] as string)).toEqual({ type: "claim", secret: toBase64Url(secret) });
    expect(states.at(-1)).toBe("online");
  });

  it("pings every 20 seconds while connected", () => {
    host.start();
    control().open();
    vi.advanceTimersByTime(20_000);
    expect(JSON.parse(control().sent[1] as string)).toEqual({ type: "ping" });
    vi.advanceTimersByTime(40_000);
    expect(control().sent).toHaveLength(4);
  });

  it("dials the session and hands it to the gateway only once it is open", () => {
    host.start();
    control().open();
    control().receive({ type: "open", session, client: "abc123" });
    const dialed = sockets[1] as FakeSocket;
    expect(dialed.url).toBe(`wss://relay.example.test/v1/host/${route.room}/${session}`);
    expect(dialed.options).toBe(PHONE_SOCKET_OPTIONS);
    expect(accepted).toHaveLength(0);
    dialed.open();
    expect(accepted).toEqual([{ socket: dialed, origin: { route: "relay", client: "abc123" } }]);
  });

  it("drops a session socket that fails before it opens", () => {
    host.start();
    control().open();
    control().receive({ type: "open", session, client: "abc123" });
    const dialed = sockets[1] as FakeSocket;
    dialed.emit("error", new Error("nope"));
    dialed.drop();
    dialed.open();
    expect(accepted).toHaveLength(0);
    // The slot is free again.
    for (let index = 0; index < 8; index += 1) control().receive({ type: "open", session, client: `c${index}` });
    expect(sockets).toHaveLength(10);
  });

  it("refuses a ninth simultaneous session", () => {
    host.start();
    control().open();
    for (let index = 0; index < 9; index += 1) control().receive({ type: "open", session, client: `c${index}` });
    expect(sockets).toHaveLength(9);
  });

  it("goes offline when the control socket drops, then reconnects after a backoff", () => {
    host.start();
    control().open();
    control().drop();
    expect(states.at(-1)).toBe("offline");
    vi.advanceTimersByTime(499);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
    expect(states.at(-1)).toBe("connecting");
  });

  it("backs off further on repeated failures, capped at a minute", () => {
    host.start();
    let previous = 0;
    for (let index = 0; index < 10; index += 1) {
      (sockets.at(-1) as FakeSocket).drop();
      const before = sockets.length;
      let waited = 0;
      while (sockets.length === before) {
        vi.advanceTimersByTime(250);
        waited += 250;
      }
      expect(waited).toBeGreaterThanOrEqual(previous);
      expect(waited).toBeLessThanOrEqual(60_000);
      previous = waited;
    }
    expect(previous).toBeGreaterThan(20_000);
  });

  it("stops pinging once the control socket is gone", () => {
    host.start();
    control().open();
    control().drop();
    vi.advanceTimersByTime(19_000);
    expect(control().sent).toHaveLength(1);
  });

  it("waits for the next UTC midnight after a budget message", () => {
    host.start();
    control().open();
    control().receive({ type: "budget" });
    expect(states.at(-1)).toBe("budget-exhausted");
    expect(control().readyState).toBe(3);
    // Twelve hours to midnight, plus 2.5 minutes of jitter at random() = 0.5.
    vi.advanceTimersByTime(12 * 3600_000);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(150_000);
    expect(sockets).toHaveLength(2);
    expect(states.at(-1)).toBe("connecting");
  });

  it("does not treat the control close after a budget message as an outage", () => {
    host.start();
    control().open();
    control().receive({ type: "budget" });
    control().drop();
    vi.advanceTimersByTime(3600_000);
    expect(sockets).toHaveLength(1);
    expect(states.at(-1)).toBe("budget-exhausted");
  });

  it("retries a budget-exhausted host on an explicit start after stop", () => {
    host.start();
    control().open();
    control().receive({ type: "budget" });
    host.stop();
    host.start();
    expect(sockets).toHaveLength(2);
    (sockets[1] as FakeSocket).open();
    vi.advanceTimersByTime(24 * 3600_000);
    expect(sockets).toHaveLength(2);
  });

  it("stop closes everything and never reconnects", () => {
    host.start();
    control().open();
    control().receive({ type: "open", session, client: "abc123" });
    const dialed = sockets[1] as FakeSocket;
    dialed.open();
    host.stop();
    expect(control().readyState).toBe(3);
    expect(dialed.readyState).toBe(3);
    expect(states.at(-1)).toBe("off");
    vi.advanceTimersByTime(10 * 60_000);
    expect(sockets).toHaveLength(2);
  });

  it("does not hand over a session that opens after stop", () => {
    host.start();
    control().open();
    control().receive({ type: "open", session, client: "abc123" });
    const pending = sockets[1] as FakeSocket;
    host.stop();
    pending.open();
    expect(accepted).toHaveLength(0);
  });

  it("ignores a malformed server message", () => {
    host.start();
    control().open();
    for (const bad of ["not json", "{}", { type: "open", session: "../x", client: "a" }, { type: "nope" }, "[]"]) {
      expect(() => control().receive(bad)).not.toThrow();
    }
    expect(sockets).toHaveLength(1);
    expect(states.at(-1)).toBe("online");
  });

  it("closes a control socket that sends more than 4 KiB", () => {
    host.start();
    control().open();
    control().receive("x".repeat(4097));
    expect(control().closeCode).toBe(1009);
  });

  it("survives a control socket error", () => {
    host.start();
    expect(() => control().emit("error", new Error("boom"))).not.toThrow();
  });

  it("start is a no-op while already running", () => {
    host.start();
    host.start();
    expect(sockets).toHaveLength(1);
  });

  /** Waits for the next dial and returns how long it took, in 250 ms steps. */
  const nextDial = (limit = 200_000) => {
    const before = sockets.length;
    let waited = 0;
    while (sockets.length === before && waited < limit) {
      vi.advanceTimersByTime(250);
      waited += 250;
    }
    return sockets.length === before ? Number.POSITIVE_INFINITY : waited;
  };
  const last = () => sockets.at(-1) as FakeSocket;

  it("keeps growing the backoff when the relay closes right after open", () => {
    host.start();
    const waits: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      last().open();
      last().drop();
      waits.push(nextDial());
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000]);
  });

  it("starts the backoff over once the link has held for 30 seconds", () => {
    host.start();
    for (let index = 0; index < 3; index += 1) {
      last().drop();
      nextDial();
    }
    last().open();
    vi.advanceTimersByTime(30_000);
    last().drop();
    expect(nextDial()).toBe(1000);
  });

  it("waits at least a minute after the relay rejects the claim", () => {
    host.start();
    control().open();
    control().drop(1008);
    expect(nextDial()).toBe(60_000);
    last().open();
    last().drop(1008);
    expect(nextDial()).toBe(60_000);
  });

  it("stays replaced and does not retry when another desktop claims the room", () => {
    host.start();
    control().open();
    control().drop(4409);
    expect(states.at(-1)).toBe("replaced");
    vi.advanceTimersByTime(10 * 60_000);
    expect(sockets).toHaveLength(1);
    host.stop();
    host.start();
    expect(sockets).toHaveLength(2);
  });

  it("treats 4000 as an ordinary drop and retries, since 4000 is the protocol code and not a replacement", () => {
    host.start();
    control().open();
    control().drop(4000);
    expect(states.at(-1)).toBe("offline");
    expect(nextDial()).toBe(1000);
  });

  it("terminates a control socket that has not opened in 15 seconds", () => {
    host.start();
    const terminate = vi.spyOn(control(), "terminate");
    vi.advanceTimersByTime(14_999);
    expect(terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(terminate).toHaveBeenCalled();
    expect(states.at(-1)).toBe("offline");
  });

  it("does not terminate a control socket that opened in time", () => {
    host.start();
    const terminate = vi.spyOn(control(), "terminate");
    control().open();
    vi.advanceTimersByTime(14_000);
    expect(terminate).not.toHaveBeenCalled();
  });

  it("terminates a session socket that has not opened in 15 seconds and frees its slot", () => {
    host.start();
    control().open();
    for (let index = 0; index < 8; index += 1) control().receive({ type: "open", session, client: `c${index}` });
    control().receive({ type: "open", session, client: "extra" });
    expect(sockets).toHaveLength(9);
    vi.advanceTimersByTime(15_000);
    expect(accepted).toHaveLength(0);
    control().receive({ type: "open", session, client: "later" });
    expect(sockets).toHaveLength(10);
  });

  it("sends a protocol ping with each app ping", () => {
    host.start();
    control().open();
    vi.advanceTimersByTime(20_000);
    expect(control().pings).toBe(1);
  });

  it("drops a control socket that stops answering pings, then backs off", () => {
    host.start();
    control().open();
    control().autoPong = false;
    vi.advanceTimersByTime(20_000 * 3);
    expect(control().readyState).toBe(3);
    expect(states.at(-1)).toBe("offline");
    expect(nextDial()).toBe(1000);
  });

  it("takes the relay's pong reply to its app ping as an answer, and stays connected on it", () => {
    host.start();
    control().open();
    control().autoPong = false;
    for (let index = 0; index < 4; index += 1) {
      vi.advanceTimersByTime(20_000);
      control().receive({ type: "pong" });
    }
    expect(control().readyState).toBe(1);
    expect(control().closeCode).toBeUndefined();
    expect(states.at(-1)).toBe("online");
  });

  it("treats a throwing createSocket as a failed dial, not an escaped error", () => {
    let fail = false;
    const flaky = new RelayHost({
      route,
      secret,
      gateway: { accept: () => undefined },
      createSocket: (url, options) => {
        if (fail) throw new Error("no network");
        const socket = new FakeSocket(url, options);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      onState: (state) => states.push(state),
      now: () => clock,
      random: () => 0.5,
    });
    flaky.start();
    fail = true;
    control().drop();
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(states.at(-1)).toBe("offline");
    fail = false;
    vi.advanceTimersByTime(2000);
    expect(sockets).toHaveLength(2);
    flaky.stop();
  });

  it("rejects a bad route at construction", () => {
    expect(
      () =>
        new RelayHost({
          route: { url: "ws://plain.example.test", room: route.room } as RelayRoute,
          secret,
          gateway: { accept: () => undefined },
          createSocket: () => undefined as never,
          onState: () => undefined,
        }),
    ).toThrow();
  });

  it("ignores a late open on a control socket it detached after a budget message", () => {
    host.start();
    control().open();
    control().receive({ type: "budget" });
    const sent = control().sent.length;
    control().open();
    expect(control().sent).toHaveLength(sent);
    expect(states.at(-1)).toBe("budget-exhausted");
  });
  it("a late close from an old control socket does not cancel the new socket deadline", () => {
    host.start();
    const old = control();
    old.deferClose = true;
    host.stop();
    host.start();
    const fresh = last();
    const terminate = vi.spyOn(fresh, "terminate");
    old.emit("close", 1006);
    vi.advanceTimersByTime(15_000);
    expect(terminate).toHaveBeenCalled();
  });

  it("a late pong from an old control socket does not reset the new socket count", () => {
    host.start();
    const old = control();
    old.open();
    old.deferClose = true;
    host.stop();
    host.start();
    const fresh = last();
    fresh.open();
    fresh.autoPong = false;
    vi.advanceTimersByTime(40_000);
    old.emit("pong");
    vi.advanceTimersByTime(20_000);
    expect(fresh.readyState).toBe(3);
  });

  it("skips a session whose socket cannot be created", () => {
    let fail = false;
    const picky = new RelayHost({
      route,
      secret,
      gateway: { accept: () => undefined },
      createSocket: (url, options) => {
        if (fail) throw new Error("no network");
        const socket = new FakeSocket(url, options);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      onState: () => undefined,
      random: () => 0.5,
    });
    picky.start();
    control().open();
    fail = true;
    expect(() => control().receive({ type: "open", session, client: "a" })).not.toThrow();
    fail = false;
    control().receive({ type: "open", session, client: "b" });
    expect(sockets).toHaveLength(2);
    picky.stop();
  });
});
