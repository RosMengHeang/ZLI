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

/** Control sockets that have not claimed yet. Only the desktop ever claims, so two is plenty. */
export const MAX_UNCLAIMED_CONTROLS = 2;

/** Limits with any valid overrides from a JSON string applied. Tests use it to shorten timers. */
export function limitsFrom(raw: string | undefined): RoomLimits {
  const limits = { ...DEFAULT_LIMITS };
  if (!raw) return limits;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return limits;
  }
  if (typeof parsed !== "object" || parsed === null) return limits;
  for (const key of Object.keys(limits) as Array<keyof RoomLimits>) {
    const value: unknown = (parsed as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) limits[key] = value;
  }
  return limits;
}

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

/** Forwarded frames on one UTC day. Kept outside the room so a restart does not reset it. */
export interface BudgetState {
  day: string;
  count: number;
  told: boolean;
}

export interface BudgetStore {
  load(): BudgetState | undefined;
  save(state: BudgetState): void;
}

/** Saving every frame would cost a storage write per frame; a restart can lose at most this many. */
const BUDGET_SAVE_EVERY = 64;

export const CLOSE_NORMAL = 1000;
export const CLOSE_POLICY = 1008;
export const CLOSE_TOO_BIG = 1009;
export const CLOSE_TRY_AGAIN = 1013;
export const CLOSE_REPLACED = 4000;

/** A socket as the Durable Object knows it after waking from hibernation. */
export type RestoredSocket =
  | { role: "control"; socket: PipeSocket; claimed: boolean; seenAt?: number | undefined }
  | { role: "phone" | "host"; session: string; socket: PipeSocket; seenAt?: number | undefined };

interface Session {
  phone: PipeSocket;
  host: PipeSocket | null;
  /** Frames the phone sent before the desktop dialed in. */
  waiting: Array<string | ArrayBuffer>;
  openedAt: number;
  seenAt: number;
  /** Bytes the phone sent before the desktop's first frame. */
  unanswered: number;
  hostSpoke: boolean;
}

export function newSessionId(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

export class RelayRoom {
  readonly #roomId: string;
  readonly #limits: RoomLimits;
  readonly #clock: RoomClock;
  readonly #store: BudgetStore | undefined;
  #host: PipeSocket | null = null;
  #hostSeenAt = 0;
  /** Control sockets that have not claimed, with when they connected. */
  readonly #unclaimed = new Map<PipeSocket, number>();
  /*
   * Sockets the room closed. A close can take a while to land (or never land, if the client is
   * silent), so their state is freed at once and anything they still send is ignored.
   */
  readonly #closed = new WeakSet<PipeSocket>();
  readonly #sessions = new Map<string, Session>();
  #budget: BudgetState;
  #unsaved = 0;
  #timer: { handle: unknown; at: number } | null = null;

  constructor(
    roomId: string,
    limits: RoomLimits = DEFAULT_LIMITS,
    clock: RoomClock = systemClock,
    store?: BudgetStore,
  ) {
    this.#roomId = roomId;
    this.#limits = limits;
    this.#clock = clock;
    this.#store = store;
    this.#budget = store?.load() ?? { day: utcDay(clock.now()), count: 0, told: false };
  }

  isHost(socket: PipeSocket): boolean {
    return this.#host === socket;
  }

  /** A new control socket. It must claim within the dial timeout, and only a few may wait. */
  controlConnected(socket: PipeSocket): boolean {
    if (this.#unclaimed.size >= MAX_UNCLAIMED_CONTROLS) {
      this.#closeControl(socket, CLOSE_TRY_AGAIN, "Too many unclaimed connections.");
      return false;
    }
    this.#unclaimed.set(socket, this.#clock.now());
    this.#schedule();
    return true;
  }

  /** Takes the room only with the secret it was derived from. The relay keeps no copy of it. */
  claimHost(socket: PipeSocket, secret: string): boolean {
    if (this.#closed.has(socket)) return false;
    let matches = false;
    try {
      matches = roomIdFromSecret(fromBase64Url(secret)) === this.#roomId;
    } catch {
      matches = false;
    }
    if (!matches) {
      this.#closeControl(socket, CLOSE_POLICY, "Wrong room secret.");
      return false;
    }
    this.#unclaimed.delete(socket);
    const previous = this.#host;
    this.#host = socket;
    this.#hostSeenAt = this.#clock.now();
    // A desktop that reconnects replaces its own stale socket.
    if (previous && previous !== socket)
      this.#closeControl(previous, CLOSE_REPLACED, "Another desktop claimed this room.");
    if (this.#overBudget()) this.#tellBudget();
    this.#schedule();
    return true;
  }

  /** Control socket traffic. Only small JSON control messages travel here, never session frames. */
  hostControl(socket: PipeSocket, data: string | ArrayBuffer): void {
    if (this.#closed.has(socket)) return;
    const message = typeof data === "string" ? parseControl(data) : null;
    if (message?.type === "claim") {
      this.claimHost(socket, message.secret);
      return;
    }
    // Heartbeats only count from the host that holds the room.
    if (message?.type === "ping" && this.isHost(socket)) {
      this.#hostSeenAt = this.#clock.now();
      return;
    }
    this.#closeControl(socket, CLOSE_POLICY, "Unexpected control message.");
  }

  hostControlClosed(socket: PipeSocket): void {
    this.#unclaimed.delete(socket);
    if (this.#host === socket) this.#host = null;
  }

  phoneConnected(socket: PipeSocket, client: string, session: string = newSessionId()): "queued" | "rejected" {
    const host = this.#liveHost();
    const refusal = this.#phoneRefusal(session);
    if (!host || refusal) {
      socket.close(CLOSE_TRY_AGAIN, refusal ?? "The desktop is offline.");
      return "rejected";
    }
    const now = this.#clock.now();
    this.#sessions.set(session, {
      phone: socket,
      host: null,
      waiting: [],
      openedAt: now,
      seenAt: now,
      unanswered: 0,
      hostSpoke: false,
    });
    host.send(JSON.stringify({ type: "open", session, client }));
    this.#schedule();
    return "queued";
  }

  sessionHostConnected(session: string, socket: PipeSocket): boolean {
    const entry = this.#sessions.get(session);
    if (!entry || entry.host) {
      socket.close(CLOSE_POLICY, "Unknown session.");
      return false;
    }
    entry.host = socket;
    entry.seenAt = this.#clock.now();
    for (const frame of entry.waiting) socket.send(frame);
    entry.waiting = [];
    return true;
  }

  /*
   * `socket` must be the one joined on that side. A socket the room turned away (a duplicate dial,
   * a reused session id) still fires its events and must not touch the pair.
   */
  onFrame(from: "phone" | "host", session: string, data: string | ArrayBuffer, socket: PipeSocket): void {
    const entry = this.#sessions.get(session);
    if (!entry || !isJoined(entry, from, socket)) return;
    const size = byteLength(data);
    if (size > this.#limits.maxFrameBytes) {
      this.#endSession(session, entry, CLOSE_TOO_BIG, "Frame too large.");
      return;
    }
    if (this.#overBudget()) {
      this.#tellBudget();
      this.#endSession(session, entry, CLOSE_TRY_AGAIN, "The daily message budget is used up.");
      return;
    }
    if (from === "phone" && !entry.hostSpoke) {
      // Until the desktop answers, the phone is unauthenticated, so it may only send a handshake.
      entry.unanswered += size;
      if (entry.unanswered > this.#limits.handshakeBytesCap) {
        this.#endSession(session, entry, CLOSE_POLICY, "Too much data before the desktop answered.");
        return;
      }
    }
    entry.seenAt = this.#clock.now();
    if (from === "host") {
      entry.hostSpoke = true;
      entry.phone.send(data);
    } else if (entry.host) {
      entry.host.send(data);
    } else {
      entry.waiting.push(data);
    }
    this.#countFrame();
  }

  onClose(from: "phone" | "host", session: string, socket: PipeSocket): void {
    const entry = this.#sessions.get(session);
    if (!entry || !isJoined(entry, from, socket)) return;
    const peer = from === "phone" ? entry.host : entry.phone;
    this.#sessions.delete(session);
    peer?.close(CLOSE_NORMAL, "The other side left.");
  }

  /*
   * After hibernation the in-memory maps are gone, so the Durable Object hands back every socket
   * with the role and session it was tagged with. Joined pairs carry on. A phone still waiting for
   * its desktop lost its queued frames and dial deadline, so it is closed and can retry, and so is
   * a control socket that had not claimed.
   */
  restore(sockets: readonly RestoredSocket[]): void {
    const now = this.#clock.now();
    const phones = new Map<string, { socket: PipeSocket; seenAt: number }>();
    const hosts = new Map<string, { socket: PipeSocket; seenAt: number }>();
    for (const item of sockets) {
      const seenAt = item.seenAt ?? now;
      if (item.role === "control") {
        if (item.claimed && !this.#host) {
          this.#host = item.socket;
          this.#hostSeenAt = seenAt;
        } else {
          this.#closeControl(item.socket, CLOSE_TRY_AGAIN, "The relay restarted.");
        }
      } else {
        (item.role === "phone" ? phones : hosts).set(item.session, { socket: item.socket, seenAt });
      }
    }
    for (const [session, phone] of phones) {
      const host = hosts.get(session);
      if (host) {
        // A joined pair is past its handshake as far as the room can tell, so the cap is lifted.
        this.#sessions.set(session, {
          phone: phone.socket,
          host: host.socket,
          waiting: [],
          openedAt: now,
          seenAt: Math.max(phone.seenAt, host.seenAt),
          unanswered: 0,
          hostSpoke: true,
        });
      } else {
        phone.socket.close(CLOSE_TRY_AGAIN, "The relay restarted.");
      }
    }
    for (const [session, host] of hosts) {
      if (!phones.has(session)) host.socket.close(CLOSE_POLICY, "Unknown session.");
    }
    this.#schedule();
  }

  /** Closes whatever has run past its deadline, then waits for the next one. */
  sweep(): void {
    this.#timer = null;
    const now = this.#clock.now();
    for (const [socket, at] of this.#unclaimed) {
      if (now - at >= this.#limits.dialTimeoutMs) this.#closeControl(socket, CLOSE_POLICY, "Did not claim in time.");
    }
    this.#liveHost();
    for (const [session, entry] of this.#sessions) {
      if (!entry.host && now - entry.openedAt >= this.#limits.dialTimeoutMs) {
        this.#sessions.delete(session);
        entry.phone.close(CLOSE_TRY_AGAIN, "The desktop did not answer.");
      } else if (now - entry.seenAt >= this.#limits.idleTimeoutMs) {
        this.#endSession(session, entry, CLOSE_NORMAL, "Idle for too long.");
      }
    }
    this.#schedule();
  }

  /** The host, or null once it has missed its heartbeats. Checked on use too, not only by sweeps. */
  #liveHost(): PipeSocket | null {
    const host = this.#host;
    if (host && this.#clock.now() - this.#hostSeenAt >= this.#limits.idleTimeoutMs * 2) {
      this.#closeControl(host, CLOSE_TRY_AGAIN, "No heartbeat.");
      return null;
    }
    return host;
  }

  /** Frees the socket's place in the room before closing it, so a stalled close holds nothing. */
  #closeControl(socket: PipeSocket, code: number, reason: string): void {
    this.hostControlClosed(socket);
    this.#closed.add(socket);
    socket.close(code, reason);
  }

  #endSession(session: string, entry: Session, code: number, reason: string): void {
    this.#sessions.delete(session);
    entry.phone.close(code, reason);
    entry.host?.close(code, reason);
  }

  #phoneRefusal(session: string): string | null {
    if (this.#sessions.has(session)) return "The desktop is offline.";
    if (this.#overBudget()) return "The daily message budget is used up.";
    let pending = 0;
    for (const entry of this.#sessions.values()) if (!entry.host) pending += 1;
    if (pending >= this.#limits.maxPendingPhones) return "Too many phones are waiting.";
    if (this.#sessions.size >= this.#limits.maxActiveSessions) return "Too many sessions.";
    return null;
  }

  #today(): BudgetState {
    const day = utcDay(this.#clock.now());
    if (this.#budget.day !== day) {
      this.#budget = { day, count: 0, told: false };
      this.#unsaved = 0;
    }
    return this.#budget;
  }

  #overBudget(): boolean {
    return this.#today().count >= this.#limits.messagesPerDay;
  }

  #countFrame(): void {
    const budget = this.#today();
    budget.count += 1;
    this.#unsaved += 1;
    if (budget.count >= this.#limits.messagesPerDay) this.#tellBudget();
    if (this.#unsaved >= BUDGET_SAVE_EVERY || budget.count === 1) this.#saveBudget();
  }

  /** Tells the host once a day. If no host is there, the next one to claim is told. */
  #tellBudget(): void {
    const budget = this.#today();
    if (!budget.told && this.#host) {
      this.#host.send(JSON.stringify({ type: "budget" }));
      budget.told = true;
    }
    this.#saveBudget();
  }

  #saveBudget(): void {
    this.#unsaved = 0;
    this.#store?.save(this.#budget);
  }

  #schedule(): void {
    let next = Number.POSITIVE_INFINITY;
    for (const at of this.#unclaimed.values()) next = Math.min(next, at + this.#limits.dialTimeoutMs);
    if (this.#host) next = Math.min(next, this.#hostSeenAt + this.#limits.idleTimeoutMs * 2);
    for (const entry of this.#sessions.values()) {
      next = Math.min(next, entry.seenAt + this.#limits.idleTimeoutMs);
      if (!entry.host) next = Math.min(next, entry.openedAt + this.#limits.dialTimeoutMs);
    }
    // Deadlines only move later between sweeps, so an earlier timer can stay; the sweep reschedules.
    if (this.#timer && this.#timer.at <= next) return;
    if (this.#timer) this.#clock.clearTimer(this.#timer.handle);
    this.#timer = null;
    if (next === Number.POSITIVE_INFINITY) return;
    const now = this.#clock.now();
    this.#timer = { handle: this.#clock.setTimer(() => this.sweep(), Math.max(0, next - now)), at: next };
  }
}

function isJoined(entry: Session, from: "phone" | "host", socket: PipeSocket): boolean {
  return (from === "phone" ? entry.phone : entry.host) === socket;
}

function parseControl(text: string): RelayHostMessage | null {
  try {
    const parsed = RelayHostMessage.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function utcDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/** UTF-8 length of a text frame, counted without copying it. */
function byteLength(data: string | ArrayBuffer): number {
  if (typeof data !== "string") return data.byteLength;
  let bytes = 0;
  for (let i = 0; i < data.length; i += 1) {
    const code = data.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code < 0xdc00 && i + 1 < data.length) {
      // A surrogate pair is one four-byte character.
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}
