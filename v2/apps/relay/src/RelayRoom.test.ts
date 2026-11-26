import { roomIdFromSecret, toBase64Url } from "@zli-v2/remote-protocol";
import { describe, expect, it } from "vitest";

import { DEFAULT_LIMITS, type PipeSocket, RelayRoom, type RoomClock } from "./RelayRoom.js";

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
    room.onFrame("phone", session, "first");
    room.onFrame("phone", session, binary);
    room.onFrame("phone", session, "third");

    const sessionHost = new FakeSocket();
    expect(room.sessionHostConnected(session, sessionHost)).toBe(true);
    expect(sessionHost.sent).toEqual(["first", binary, "third"]);

    room.onFrame("phone", session, "fourth");
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
    room.sessionHostConnected(sessionA, new FakeSocket());
    room.sessionHostConnected(sessionB, new FakeSocket());

    room.onFrame("host", sessionB, "for b");
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
    room.phoneConnected(new FakeSocket(), "client-a");
    const { session } = openMessage(host);
    const sessionHost = new FakeSocket();
    room.sessionHostConnected(session, sessionHost);

    room.onClose("phone", session);
    expect(sessionHost.closed?.code).toBe(1000);
    // The session is gone, so a late frame goes nowhere.
    room.onFrame("host", session, "late");
  });

  it("closes the phone when the host side leaves", () => {
    const { room, host } = claimedRoom();
    const phone = new FakeSocket();
    room.phoneConnected(phone, "client-a");
    const { session } = openMessage(host);
    room.sessionHostConnected(session, new FakeSocket());

    room.onClose("host", session);
    expect(phone.closed?.code).toBe(1000);
    expect(room.sessionHostConnected(session, new FakeSocket())).toBe(false);
  });

  it("frees a pending session when the phone leaves before the host dials", () => {
    const { room, host, clock } = claimedRoom();
    const phone = new FakeSocket();
    room.phoneConnected(phone, "client-a");
    const { session } = openMessage(host);
    room.onClose("phone", session);
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
    room.onFrame("phone", joined, "after wake");
    expect(joinedHost.sent).toEqual(["after wake"]);
    expect(lonelyPhone.closed?.code).toBe(1013);
    expect(lonelyHost.closed?.code).toBe(1008);
  });
});
