import { roomIdFromSecret, toBase64Url } from "@zli-v2/remote-protocol";
import { describe, expect, it } from "vitest";

import {
  type BudgetState,
  type BudgetStore,
  DEFAULT_LIMITS,
  limitsFrom,
  type PipeSocket,
  RelayRoom,
  type RoomClock,
} from "./RelayRoom.js";

class FakeSocket implements PipeSocket {
  sent: Array<string | ArrayBuffer> = [];
  closed: { code: number; reason?: string } | null = null;

  send(data: string | ArrayBuffer): void {
    if (this.closed) throw new Error("send after close");
    this.sent.push(data);
  }

  close(code: number, reason?: string): void {
    this.closed = reason === undefined ? { code } : { code, reason };
  }
}

class FakeClock implements RoomClock {
  time = 0;
  #timers = new Map<number, { at: number; run: () => void }>();
  #next = 1;

  now(): number {
    return this.time;
  }

  setTimer(run: () => void, ms: number): unknown {
    const id = this.#next++;
    this.#timers.set(id, { at: this.time + ms, run });
    return id;
  }

  clearTimer(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  advance(ms: number): void {
    this.time += ms;
    for (const [id, timer] of [...this.#timers]) {
      if (timer.at <= this.time) {
        this.#timers.delete(id);
        timer.run();
      }
    }
  }
}

const secretBytes = new Uint8Array(32).fill(7);
const secret = toBase64Url(secretBytes);
const roomId = roomIdFromSecret(secretBytes);
const wrongSecret = toBase64Url(new Uint8Array(32).fill(9));

function setup() {
  const clock = new FakeClock();
  const room = new RelayRoom(roomId, DEFAULT_LIMITS, clock);
  return { clock, room };
}

function claimedRoom() {
  const { clock, room } = setup();
  const host = new FakeSocket();
  expect(room.claimHost(host, secret)).toBe(true);
  return { clock, room, host };
}

function openMessage(host: FakeSocket, index = 0): { type: string; session: string; client: string } {
  const message = host.sent[index];
  if (typeof message !== "string") throw new Error("expected a text control message");
  return JSON.parse(message);
}

describe("RelayRoom", () => {
  it("refuses a host with the wrong secret, and phones are then turned away", () => {
    const { room } = setup();
    const host = new FakeSocket();
    expect(room.claimHost(host, wrongSecret)).toBe(false);
    expect(host.closed?.code).toBe(1008);

    const phone = new FakeSocket();
    expect(room.phoneConnected(phone, "client-a")).toBe("rejected");
    expect(host.sent).toEqual([]);
  });

  it("refuses a secret that is not base64url", () => {
    const { room } = setup();
    expect(room.claimHost(new FakeSocket(), "not base64!")).toBe(false);
  });

  it("accepts the host with the right secret", () => {
    const { room } = setup();
    const host = new FakeSocket();
    expect(room.claimHost(host, secret)).toBe(true);
    expect(host.closed).toBeNull();
  });

  it("rejects a phone with 1013 when no desktop is connected", () => {
    const { room } = setup();
    const phone = new FakeSocket();
    expect(room.phoneConnected(phone, "client-a")).toBe("rejected");
    expect(phone.closed?.code).toBe(1013);
  });

  it("tells the host about a new phone with its session and client key", () => {
    const { room, host } = claimedRoom();
    const phone = new FakeSocket();
    expect(room.phoneConnected(phone, "client-a")).toBe("queued");

    const open = openMessage(host);
    expect(open.type).toBe("open");
    expect(open.client).toBe("client-a");
    expect(open.session).toMatch(/^[A-Za-z0-9_-]{21}[AQgw]$/u);
  });

  it("uses the session id it is given", () => {
    const { room, host } = claimedRoom();
    const session = toBase64Url(new Uint8Array(16).fill(3));
    room.phoneConnected(new FakeSocket(), "client-a", session);
    expect(openMessage(host).session).toBe(session);
  });

  it("gives each phone its own session", () => {
    const { room, host } = claimedRoom();
    room.phoneConnected(new FakeSocket(), "client-a");
    room.phoneConnected(new FakeSocket(), "client-a");
    expect(openMessage(host, 0).session).not.toBe(openMessage(host, 1).session);
  });

  it("delivers frames the phone sent while waiting, in order, once the host dials", () => {
    const { room, host } = claimedRoom();
    const phone = new FakeSocket();
    room.phoneConnected(phone, "client-a");
    const { session } = openMessage(host);

    const binary = new Uint8Array([1, 2, 3]).buffer;
    room.onFrame("phone", session, "first", phone);
    room.onFrame("phone", session, binary, phone);
    room.onFrame("phone", session, "third", phone);

    const sessionHost = new FakeSocket();
    expect(room.sessionHostConnected(session, sessionHost)).toBe(true);
    expect(sessionHost.sent).toEqual(["first", binary, "third"]);

    room.onFrame("phone", session, "fourth", phone);
    expect(sessionHost.sent.at(-1)).toBe("fourth");
    // Frames never leak onto the control socket.
    expect(host.sent).toHaveLength(1);
  });

  it("sends a host frame only to the matching phone", () => {
    const { room, host } = claimedRoom();
    const phoneA = new FakeSocket();
    const phoneB = new FakeSocket();
    room.phoneConnected(phoneA, "client-a");
    room.phoneConnected(phoneB, "client-b");
    const sessionA = openMessage(host, 0).session;
    const sessionB = openMessage(host, 1).session;
    const hostB = new FakeSocket();
    room.sessionHostConnected(sessionA, new FakeSocket());
    room.sessionHostConnected(sessionB, hostB);

    room.onFrame("host", sessionB, "for b", hostB);
    expect(phoneB.sent).toEqual(["for b"]);
    expect(phoneA.sent).toEqual([]);
  });

  it("refuses a session host for an unknown or already joined session", () => {
    const { room, host } = claimedRoom();
    room.phoneConnected(new FakeSocket(), "client-a");
    const { session } = openMessage(host);

    const stranger = new FakeSocket();
    expect(room.sessionHostConnected(toBase64Url(new Uint8Array(16)), stranger)).toBe(false);
    expect(stranger.closed?.code).toBe(1008);

    expect(room.sessionHostConnected(session, new FakeSocket())).toBe(true);
    const second = new FakeSocket();
    expect(room.sessionHostConnected(session, second)).toBe(false);
    expect(second.closed?.code).toBe(1008);
  });

  it("ignores close and frames from a socket that was turned away", () => {
    const { room, host } = claimedRoom();
    const phone = new FakeSocket();
    room.phoneConnected(phone, "client-a");
    const { session } = openMessage(host);
    const sessionHost = new FakeSocket();
    room.sessionHostConnected(session, sessionHost);

    const duplicate = new FakeSocket();
    room.sessionHostConnected(session, duplicate);
    room.onFrame("host", session, "spoof", duplicate);
    room.onClose("host", session, duplicate);
    expect(phone.sent).toEqual([]);
    expect(phone.closed).toBeNull();

    const twin = new FakeSocket();
    expect(room.phoneConnected(twin, "client-a", session)).toBe("rejected");
    room.onClose("phone", session, twin);
    expect(sessionHost.closed).toBeNull();
  });

  it("closes the host side when the phone leaves", () => {
    const { room, host } = claimedRoom();
    const phone = new FakeSocket();
    room.phoneConnected(phone, "client-a");
    const { session } = openMessage(host);
    const sessionHost = new FakeSocket();
    room.sessionHostConnected(session, sessionHost);

    room.onClose("phone", session, phone);
    expect(sessionHost.closed?.code).toBe(1000);
    // The session is gone, so a late frame goes nowhere.
    room.onFrame("host", session, "late", sessionHost);
    expect(phone.sent).toEqual([]);
  });

  it("closes the phone when the host side leaves", () => {
    const { room, host } = claimedRoom();
    const phone = new FakeSocket();
    room.phoneConnected(phone, "client-a");
    const { session } = openMessage(host);
    const sessionHost = new FakeSocket();
    room.sessionHostConnected(session, sessionHost);

    room.onClose("host", session, sessionHost);
    expect(phone.closed?.code).toBe(1000);
    expect(room.sessionHostConnected(session, new FakeSocket())).toBe(false);
  });

  it("frees a pending session when the phone leaves before the host dials", () => {
    const { room, host, clock } = claimedRoom();
    const phone = new FakeSocket();
    room.phoneConnected(phone, "client-a");
    const { session } = openMessage(host);
    room.onClose("phone", session, phone);
    expect(room.sessionHostConnected(session, new FakeSocket())).toBe(false);
    clock.advance(DEFAULT_LIMITS.dialTimeoutMs);
    expect(phone.closed).toBeNull();
  });

  it("closes the phone with 1013 when the host never dials in time", () => {
    const { room, clock } = claimedRoom();
    const phone = new FakeSocket();
    room.phoneConnected(phone, "client-a");
    clock.advance(DEFAULT_LIMITS.dialTimeoutMs - 1);
    expect(phone.closed).toBeNull();
    clock.advance(1);
    expect(phone.closed?.code).toBe(1013);
  });

  it("keeps a session open past the dial timeout once the host dials", () => {
    const { room, host, clock } = claimedRoom();
    const phone = new FakeSocket();
    room.phoneConnected(phone, "client-a");
    room.sessionHostConnected(openMessage(host).session, new FakeSocket());
    clock.advance(DEFAULT_LIMITS.dialTimeoutMs * 2);
    expect(phone.closed).toBeNull();
  });

  it("closes the first host with 4000 when a second one claims the room", () => {
    const { room, host } = claimedRoom();
    const second = new FakeSocket();
    expect(room.claimHost(second, secret)).toBe(true);
    expect(host.closed?.code).toBe(4000);

    room.phoneConnected(new FakeSocket(), "client-a");
    expect(host.sent).toEqual([]);
    expect(openMessage(second).type).toBe("open");
  });

  it("drops the room at once when the current host re-claims with a wrong secret", () => {
    const { room, host } = claimedRoom();
    expect(room.claimHost(host, wrongSecret)).toBe(false);
    expect(room.isHost(host)).toBe(false);

    const phone = new FakeSocket();
    expect(room.phoneConnected(phone, "client-a")).toBe("rejected");
    expect(phone.closed?.code).toBe(1013);
  });

  it("keeps the current host when a stranger fails to claim", () => {
    const { room, host } = claimedRoom();
    expect(room.claimHost(new FakeSocket(), wrongSecret)).toBe(false);
    expect(room.isHost(host)).toBe(true);
  });

  it("goes offline when the host control socket closes, ignoring a replaced host", () => {
    const { room, host } = claimedRoom();
    const second = new FakeSocket();
    room.claimHost(second, secret);
    room.hostControlClosed(host);
    expect(room.phoneConnected(new FakeSocket(), "client-a")).toBe("queued");

    room.hostControlClosed(second);
    expect(room.phoneConnected(new FakeSocket(), "client-a")).toBe("rejected");
  });

  it("handles control messages from the host", () => {
    const { room } = setup();
    const host = new FakeSocket();
    room.hostControl(host, JSON.stringify({ type: "claim", secret }));
    expect(room.isHost(host)).toBe(true);
    room.hostControl(host, JSON.stringify({ type: "ping" }));
    expect(host.closed).toBeNull();

    const junk = new FakeSocket();
    room.hostControl(junk, "{not json");
    expect(junk.closed?.code).toBe(1008);
    const binary = new FakeSocket();
    room.hostControl(binary, new Uint8Array([1]).buffer);
    expect(binary.closed?.code).toBe(1008);
  });

  it("refuses control messages other than claim before the host has claimed", () => {
    const { room } = setup();
    const host = new FakeSocket();
    room.hostControl(host, JSON.stringify({ type: "ping" }));
    expect(host.closed?.code).toBe(1008);
  });

  it("rebuilds joined sessions after waking and closes half-open ones", () => {
    const { room } = setup();
    const control = new FakeSocket();
    const joinedPhone = new FakeSocket();
    const joinedHost = new FakeSocket();
    const lonelyPhone = new FakeSocket();
    const lonelyHost = new FakeSocket();
    const joined = toBase64Url(new Uint8Array(16).fill(1));

    room.restore([
      { role: "control", socket: control, claimed: true },
      { role: "phone", session: joined, socket: joinedPhone },
      { role: "host", session: joined, socket: joinedHost },
      { role: "phone", session: toBase64Url(new Uint8Array(16).fill(2)), socket: lonelyPhone },
      { role: "host", session: toBase64Url(new Uint8Array(16).fill(3)), socket: lonelyHost },
    ]);

    expect(room.isHost(control)).toBe(true);
    room.onFrame("phone", joined, "after wake", joinedPhone);
    expect(joinedHost.sent).toEqual(["after wake"]);
    expect(lonelyPhone.closed?.code).toBe(1013);
    expect(lonelyHost.closed?.code).toBe(1008);
  });
});

function limited(overrides: Partial<typeof DEFAULT_LIMITS>, store?: MemoryBudget) {
  const clock = new FakeClock();
  const room = new RelayRoom(roomId, { ...DEFAULT_LIMITS, ...overrides }, clock, store);
  const host = new FakeSocket();
  expect(room.claimHost(host, secret)).toBe(true);
  return { clock, room, host };
}

/** Opens a phone and dials the host side, so the pair is joined. */
function join(room: RelayRoom, host: FakeSocket, client = "client-a") {
  const phone = new FakeSocket();
  const before = host.sent.length;
  expect(room.phoneConnected(phone, client)).toBe("queued");
  const { session } = openMessage(host, before);
  const sessionHost = new FakeSocket();
  expect(room.sessionHostConnected(session, sessionHost)).toBe(true);
  return { phone, sessionHost, session };
}

class MemoryBudget implements BudgetStore {
  state: BudgetState | undefined;
  load(): BudgetState | undefined {
    return this.state;
  }
  save(state: BudgetState): void {
    this.state = { ...state };
  }
}

const DAY = 24 * 60 * 60 * 1000;
const BUDGET = JSON.stringify({ type: "budget" });

function budgetNotices(host: FakeSocket): number {
  return host.sent.filter((message) => message === BUDGET).length;
}

describe("RelayRoom limits", () => {
  it("rejects the fifth pending phone with 1013", () => {
    const { room } = claimedRoom();
    for (let i = 0; i < DEFAULT_LIMITS.maxPendingPhones; i += 1) {
      expect(room.phoneConnected(new FakeSocket(), "client-a")).toBe("queued");
    }
    const fifth = new FakeSocket();
    expect(room.phoneConnected(fifth, "client-a")).toBe("rejected");
    expect(fifth.closed?.code).toBe(1013);
  });

  it("rejects the ninth session with 1013", () => {
    const { room, host } = claimedRoom();
    for (let i = 0; i < DEFAULT_LIMITS.maxActiveSessions; i += 1) join(room, host);
    const ninth = new FakeSocket();
    expect(room.phoneConnected(ninth, "client-a")).toBe("rejected");
    expect(ninth.closed?.code).toBe(1013);
  });

  it("closes a session with 1009 when a frame is over maxFrameBytes", () => {
    const { room, host } = limited({ maxFrameBytes: 8 });
    const { phone, sessionHost, session } = join(room, host);
    room.onFrame("host", session, "12345678", sessionHost);
    expect(phone.sent).toEqual(["12345678"]);
    room.onFrame("phone", session, new Uint8Array(9).buffer, phone);
    expect(phone.closed?.code).toBe(1009);
    expect(sessionHost.closed?.code).toBe(1009);
    expect(sessionHost.sent).toEqual([]);
  });

  it("counts a text frame in UTF-8 bytes", () => {
    const { room, host } = limited({ maxFrameBytes: 8 });
    const { phone, sessionHost, session } = join(room, host);
    // Four characters, but ten bytes.
    room.onFrame("phone", session, "日本語!", phone);
    expect(phone.closed?.code).toBe(1009);
    expect(sessionHost.sent).toEqual([]);
  });

  it("closes a session that sends more than handshakeBytesCap before the host's first frame", () => {
    const { room, host } = limited({ handshakeBytesCap: 10 });
    const { phone, sessionHost, session } = join(room, host);
    room.onFrame("phone", session, "123456", phone);
    expect(sessionHost.sent).toEqual(["123456"]);
    room.onFrame("phone", session, "12345", phone);
    expect(phone.closed?.code).toBe(1008);
    expect(sessionHost.closed?.code).toBe(1008);
    expect(sessionHost.sent).toEqual(["123456"]);
  });

  it("lifts the handshake cap once the host has sent a frame", () => {
    const { room, host } = limited({ handshakeBytesCap: 10 });
    const { phone, sessionHost, session } = join(room, host);
    room.onFrame("phone", session, "123456", phone);
    room.onFrame("host", session, "hi", sessionHost);
    room.onFrame("phone", session, "1234567890", phone);
    expect(phone.closed).toBeNull();
    expect(sessionHost.sent).toEqual(["123456", "1234567890"]);
  });

  it("bounds the frames a phone queues before the host dials", () => {
    const { room, host } = limited({ handshakeBytesCap: 10, maxFrameBytes: 8 });
    const phone = new FakeSocket();
    room.phoneConnected(phone, "client-a");
    const { session } = openMessage(host);
    room.onFrame("phone", session, "12345", phone);
    room.onFrame("phone", session, "12345", phone);
    expect(phone.closed).toBeNull();
    room.onFrame("phone", session, "1", phone);
    expect(phone.closed?.code).toBe(1008);
    // The session is gone, so the host cannot join it and gets nothing.
    expect(room.sessionHostConnected(session, new FakeSocket())).toBe(false);

    const big = new FakeSocket();
    room.phoneConnected(big, "client-a");
    room.onFrame("phone", openMessage(host, 1).session, "123456789", big);
    expect(big.closed?.code).toBe(1009);
  });

  it("closes a session that is silent for idleTimeoutMs", () => {
    const { room, host, clock } = claimedRoom();
    const { phone, sessionHost, session } = join(room, host);
    clock.advance(DEFAULT_LIMITS.idleTimeoutMs / 2);
    room.onFrame("phone", session, "still here", phone);
    room.hostControl(host, JSON.stringify({ type: "ping" }));
    clock.advance(DEFAULT_LIMITS.idleTimeoutMs - 1);
    expect(phone.closed).toBeNull();
    clock.advance(1);
    expect(phone.closed?.code).toBe(1000);
    expect(sessionHost.closed?.code).toBe(1000);
  });

  it("stops forwarding after messagesPerDay frames in a UTC day and tells the host once", () => {
    const { room, host, clock } = limited({ messagesPerDay: 3 });
    const { phone, sessionHost, session } = join(room, host);
    room.onFrame("phone", session, "1", phone);
    room.onFrame("host", session, "2", sessionHost);
    expect(budgetNotices(host)).toBe(0);
    room.onFrame("phone", session, "3", phone);
    expect(host.sent.at(-1)).toBe(BUDGET);

    room.onFrame("phone", session, "4", phone);
    expect(sessionHost.sent).toEqual(["1", "3"]);
    expect(phone.closed?.code).toBe(1013);
    const late = new FakeSocket();
    expect(room.phoneConnected(late, "client-a")).toBe("rejected");
    expect(late.closed?.code).toBe(1013);
    expect(budgetNotices(host)).toBe(1);

    // A new UTC day starts a new budget.
    clock.time = DAY;
    room.hostControl(host, JSON.stringify({ type: "ping" }));
    const next = join(room, host);
    room.onFrame("phone", next.session, "5", next.phone);
    expect(next.sessionHost.sent).toEqual(["5"]);
  });

  it("keeps the day's count across a restart through the budget store", () => {
    const store = new MemoryBudget();
    const first = limited({ messagesPerDay: 3 }, store);
    const a = join(first.room, first.host);
    for (const frame of ["1", "2", "3"]) first.room.onFrame("phone", a.session, frame, a.phone);
    expect(store.state).toEqual({ day: "1970-01-01", count: 3, told: true });

    const second = limited({ messagesPerDay: 3 }, store);
    expect(second.room.phoneConnected(new FakeSocket(), "client-a")).toBe("rejected");
    // Already told today, so the new host is not told again.
    expect(budgetNotices(second.host)).toBe(0);
  });

  it("tells a host that claims after the budget ran out with no host present", () => {
    const store = new MemoryBudget();
    store.state = { day: "1970-01-01", count: 3, told: false };
    const { host } = limited({ messagesPerDay: 3 }, store);
    expect(budgetNotices(host)).toBe(1);
    expect(store.state.told).toBe(true);
  });

  it("marks the room offline when the host misses heartbeats for twice idleTimeoutMs", () => {
    const { room, host, clock } = claimedRoom();
    clock.advance(DEFAULT_LIMITS.idleTimeoutMs * 2 - 1);
    expect(room.phoneConnected(new FakeSocket(), "client-a")).toBe("queued");
    room.hostControl(host, JSON.stringify({ type: "ping" }));
    clock.advance(DEFAULT_LIMITS.idleTimeoutMs * 2 - 1);
    expect(host.closed).toBeNull();
    clock.advance(1);
    expect(host.closed?.code).toBe(1013);
    expect(room.isHost(host)).toBe(false);
    const phone = new FakeSocket();
    expect(room.phoneConnected(phone, "client-a")).toBe("rejected");
    expect(phone.closed?.code).toBe(1013);
    // A late claim from the dropped socket does not bring the room back.
    room.hostControl(host, JSON.stringify({ type: "claim", secret }));
    expect(room.isHost(host)).toBe(false);
  });

  it("rejects phones as soon as the heartbeat deadline passes, before any sweep runs", () => {
    const { room, host, clock } = claimedRoom();
    // Move time without firing timers, as a late alarm would.
    clock.time += DEFAULT_LIMITS.idleTimeoutMs * 2;
    const phone = new FakeSocket();
    expect(room.phoneConnected(phone, "client-a")).toBe("rejected");
    expect(phone.closed?.code).toBe(1013);
    expect(host.closed?.code).toBe(1013);
  });

  it("closes an unclaimed control socket after dialTimeoutMs", () => {
    const { room, clock } = setup();
    const control = new FakeSocket();
    expect(room.controlConnected(control)).toBe(true);
    clock.advance(DEFAULT_LIMITS.dialTimeoutMs - 1);
    expect(control.closed).toBeNull();
    clock.advance(1);
    expect(control.closed?.code).toBe(1008);
    // A claim that arrives after the deadline is ignored.
    room.hostControl(control, JSON.stringify({ type: "claim", secret }));
    expect(room.isHost(control)).toBe(false);
  });

  it("keeps a control socket that claims in time", () => {
    const { room, clock } = setup();
    const control = new FakeSocket();
    room.controlConnected(control);
    room.hostControl(control, JSON.stringify({ type: "claim", secret }));
    clock.advance(DEFAULT_LIMITS.dialTimeoutMs);
    expect(control.closed).toBeNull();
    expect(room.isHost(control)).toBe(true);
  });

  it("allows two unclaimed control sockets at a time", () => {
    const { room, clock } = setup();
    const first = new FakeSocket();
    const second = new FakeSocket();
    expect(room.controlConnected(first)).toBe(true);
    expect(room.controlConnected(second)).toBe(true);
    const third = new FakeSocket();
    expect(room.controlConnected(third)).toBe(false);
    expect(third.closed?.code).toBe(1013);

    // A slot frees when one claims, closes, or times out.
    room.hostControl(first, JSON.stringify({ type: "claim", secret }));
    expect(room.controlConnected(new FakeSocket())).toBe(true);
    room.hostControlClosed(second);
    expect(room.controlConnected(new FakeSocket())).toBe(true);
    expect(room.controlConnected(new FakeSocket())).toBe(false);
    clock.advance(DEFAULT_LIMITS.dialTimeoutMs);
    expect(room.controlConnected(new FakeSocket())).toBe(true);
  });

  it("closes unclaimed control sockets it finds after waking", () => {
    const { room } = setup();
    const unclaimed = new FakeSocket();
    room.restore([{ role: "control", socket: unclaimed, claimed: false }]);
    expect(unclaimed.closed?.code).toBe(1013);
  });

  it("restores idle and heartbeat clocks from what the sockets last recorded", () => {
    const { room, clock } = setup();
    clock.time = 1_000_000;
    const control = new FakeSocket();
    const phone = new FakeSocket();
    const host = new FakeSocket();
    const session = toBase64Url(new Uint8Array(16).fill(1));
    const idle = DEFAULT_LIMITS.idleTimeoutMs;
    room.restore([
      { role: "control", socket: control, claimed: true, seenAt: clock.time - idle * 2 + 20 },
      { role: "phone", session, socket: phone, seenAt: clock.time - idle + 5 },
      { role: "host", session, socket: host, seenAt: clock.time - idle + 10 },
    ]);
    clock.advance(9);
    expect(phone.closed).toBeNull();
    clock.advance(1);
    expect(phone.closed?.code).toBe(1000);
    clock.advance(9);
    expect(control.closed).toBeNull();
    clock.advance(1);
    expect(control.closed?.code).toBe(1013);
  });
});

describe("limitsFrom", () => {
  it("uses the defaults without an override", () => {
    expect(limitsFrom(undefined)).toEqual(DEFAULT_LIMITS);
    expect(limitsFrom("")).toEqual(DEFAULT_LIMITS);
  });

  it("takes known positive numbers and ignores everything else", () => {
    const raw = JSON.stringify({ dialTimeoutMs: 500, idleTimeoutMs: -1, nope: 3, messagesPerDay: "9" });
    expect(limitsFrom(raw)).toEqual({ ...DEFAULT_LIMITS, dialTimeoutMs: 500 });
    expect(limitsFrom("{not json")).toEqual(DEFAULT_LIMITS);
    expect(limitsFrom("[1]")).toEqual(DEFAULT_LIMITS);
  });
});
