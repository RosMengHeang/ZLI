import { fromBase64Url, RelayHostMessage, roomIdFromSecret, toBase64Url } from "@zli-v2/remote-protocol";

/*
 * One room per paired desktop. The room joins a phone socket to a desktop socket per session and
 * forwards frames untouched: they are end-to-end encrypted, so the room never parses or logs them.
 * Every decision lives here, in plain code with no I/O, so it can be tested outside Workers.
 */

export interface PipeSocket {
  send(data: string | ArrayBuffer): void;
  close(code: number, reason?: string): void;
}

export interface RoomLimits {
  maxPendingPhones: number;
  maxActiveSessions: number;
  maxFrameBytes: number;
  dialTimeoutMs: number;
  idleTimeoutMs: number;
  messagesPerDay: number;
  handshakeBytesCap: number;
}

export const DEFAULT_LIMITS: RoomLimits = {
  maxPendingPhones: 4,
  maxActiveSessions: 8,
  maxFrameBytes: 8 * 1024 * 1024 + 4096,
  dialTimeoutMs: 10_000,
  idleTimeoutMs: 60_000,
  messagesPerDay: 150_000,
  handshakeBytesCap: 256 * 1024,
};

/** Time and timers, injected so tests can run on fake time. */
export interface RoomClock {
  now(): number;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export const systemClock: RoomClock = {
  now: () => Date.now(),
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const CLOSE_NORMAL = 1000;
export const CLOSE_POLICY = 1008;
export const CLOSE_TRY_AGAIN = 1013;
export const CLOSE_REPLACED = 4000;

/** A socket as the Durable Object knows it after waking from hibernation. */
export type RestoredSocket =
  | { role: "control"; socket: PipeSocket; claimed: boolean }
  | { role: "phone" | "host"; session: string; socket: PipeSocket };

interface Session {
  phone: PipeSocket;
  host: PipeSocket | null;
  /** Frames the phone sent before the desktop dialed in. */
  waiting: Array<string | ArrayBuffer>;
  dialTimer: unknown;
}

export function newSessionId(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

export class RelayRoom {
  readonly #roomId: string;
  readonly #limits: RoomLimits;
  readonly #clock: RoomClock;
  #host: PipeSocket | null = null;
  readonly #sessions = new Map<string, Session>();

  constructor(roomId: string, limits: RoomLimits = DEFAULT_LIMITS, clock: RoomClock = systemClock) {
    this.#roomId = roomId;
    this.#limits = limits;
    this.#clock = clock;
  }

  isHost(socket: PipeSocket): boolean {
    return this.#host === socket;
  }

  /** Takes the room only with the secret it was derived from. The relay keeps no copy of it. */
  claimHost(socket: PipeSocket, secret: string): boolean {
    let matches = false;
    try {
      matches = roomIdFromSecret(fromBase64Url(secret)) === this.#roomId;
    } catch {
      matches = false;
    }
    if (!matches) {
      socket.close(CLOSE_POLICY, "Wrong room secret.");
      return false;
    }
    const previous = this.#host;
    this.#host = socket;
    // A desktop that reconnects replaces its own stale socket.
    if (previous && previous !== socket) previous.close(CLOSE_REPLACED, "Another desktop claimed this room.");
    return true;
  }

  /** Control socket traffic. Only small JSON control messages travel here, never session frames. */
  hostControl(socket: PipeSocket, data: string | ArrayBuffer): void {
    const message = typeof data === "string" ? parseControl(data) : null;
    if (message?.type === "claim") {
      this.claimHost(socket, message.secret);
      return;
    }
    // Heartbeats only count from the host that holds the room. Task 3 tracks them.
    if (message?.type === "ping" && this.isHost(socket)) return;
    socket.close(CLOSE_POLICY, "Unexpected control message.");
  }

  hostControlClosed(socket: PipeSocket): void {
    if (this.#host === socket) this.#host = null;
  }

  phoneConnected(socket: PipeSocket, client: string, session: string = newSessionId()): "queued" | "rejected" {
    if (!this.#host || this.#sessions.has(session)) {
      socket.close(CLOSE_TRY_AGAIN, "The desktop is offline.");
      return "rejected";
    }
    const dialTimer = this.#clock.setTimer(() => this.#dialTimedOut(session), this.#limits.dialTimeoutMs);
    this.#sessions.set(session, { phone: socket, host: null, waiting: [], dialTimer });
    this.#host.send(JSON.stringify({ type: "open", session, client }));
    return "queued";
  }

  sessionHostConnected(session: string, socket: PipeSocket): boolean {
    const entry = this.#sessions.get(session);
    if (!entry || entry.host) {
      socket.close(CLOSE_POLICY, "Unknown session.");
      return false;
    }
    this.#clock.clearTimer(entry.dialTimer);
    entry.host = socket;
    for (const frame of entry.waiting) socket.send(frame);
    entry.waiting = [];
    return true;
  }

  /*
   * `socket`, when given, must be the one joined on that side. A socket the room turned away
   * (a duplicate dial, a reused session id) still fires its events and must not touch the pair.
   */
  onFrame(from: "phone" | "host", session: string, data: string | ArrayBuffer, socket?: PipeSocket): void {
    const entry = this.#sessions.get(session);
    if (!entry || !isJoined(entry, from, socket)) return;
    if (from === "host") {
      entry.phone.send(data);
    } else if (entry.host) {
      entry.host.send(data);
    } else {
      entry.waiting.push(data);
    }
  }

  onClose(from: "phone" | "host", session: string, socket?: PipeSocket): void {
    const entry = this.#sessions.get(session);
    if (!entry || !isJoined(entry, from, socket)) return;
    const peer = from === "phone" ? entry.host : entry.phone;
    this.#drop(session, entry);
    peer?.close(CLOSE_NORMAL, "The other side left.");
  }

  /*
   * After hibernation the in-memory maps are gone, so the Durable Object hands back every socket
   * with the role and session it was tagged with. Joined pairs carry on. A phone still waiting for
   * its desktop lost its queued frames and dial timer, so it is closed and can retry.
   */
  restore(sockets: readonly RestoredSocket[]): void {
    const phones = new Map<string, PipeSocket>();
    const hosts = new Map<string, PipeSocket>();
    for (const item of sockets) {
      if (item.role === "control") {
        if (item.claimed) this.#host = item.socket;
      } else {
        (item.role === "phone" ? phones : hosts).set(item.session, item.socket);
      }
    }
    for (const [session, phone] of phones) {
      const host = hosts.get(session);
      if (host) {
        this.#sessions.set(session, { phone, host, waiting: [], dialTimer: undefined });
      } else {
        phone.close(CLOSE_TRY_AGAIN, "The relay restarted.");
      }
    }
    for (const [session, host] of hosts) {
      if (!phones.has(session)) host.close(CLOSE_POLICY, "Unknown session.");
    }
  }

  #dialTimedOut(session: string): void {
    const entry = this.#sessions.get(session);
    if (!entry || entry.host) return;
    this.#drop(session, entry);
    entry.phone.close(CLOSE_TRY_AGAIN, "The desktop did not answer.");
  }

  #drop(session: string, entry: Session): void {
    this.#clock.clearTimer(entry.dialTimer);
    this.#sessions.delete(session);
  }
}

function isJoined(entry: Session, from: "phone" | "host", socket: PipeSocket | undefined): boolean {
  const joined = from === "phone" ? entry.phone : entry.host;
  if (!joined) return false;
  return socket === undefined || socket === joined;
}

function parseControl(text: string): RelayHostMessage | null {
  try {
    const parsed = RelayHostMessage.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
