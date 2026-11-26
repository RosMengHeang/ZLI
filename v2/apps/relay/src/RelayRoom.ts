import {
  fromBase64Url,
  RelayHostMessage,
  RemoteCloseCode,
  roomIdFromSecret,
  toBase64Url,
} from "@zli-v2/remote-protocol";

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

/**
 * The relay-wide daily cap, shared by every room. `over` must answer at once, so it reports what the room last heard;
 * `counted` is told of every frame the room counts against its own budget.
 */
export interface RelayBudget {
  over(): boolean;
  counted(): void;
}

export const RELAY_LIMIT_REASON = "Relay daily limit reached.";

/** The relay-wide cap when RELAY_DAILY_FRAMES is unset or not a positive number. */
export const DEFAULT_DAILY_FRAMES = 2_000_000;

export function dailyFramesFrom(raw: string | undefined): number {
  const value = Number(raw);
  return raw !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_DAILY_FRAMES;
}

/** Frames forwarded across the whole relay on one UTC day. */
export interface DailyCount {
  day: string;
  count: number;
}

/** Adds `frames` to the count for `day`, starting again from zero on a new day. */
export function addFrames(current: DailyCount | undefined, day: string, frames: number): DailyCount {
  const base = current?.day === day ? current.count : 0;
  return { day, count: base + Math.max(0, Math.floor(frames)) };
}

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

/*
 * Saving every frame would cost a storage write per frame. An eviction forgets the frames counted
 * since the last save, at most 7, so each one lets 7 extra frames through. Counting starts once the
 * desktop has answered a session, which is before the phone has authenticated. Evictions follow idle
 * time or a deploy, so a client gains at most 7 frames per idle gap. Against a daily cap of 150 000
 * that is a rounding error.
 */
const BUDGET_SAVE_EVERY = 8;

/** Phone frames allowed before the desktop's first frame. A handshake needs only a couple. */
export const MAX_HANDSHAKE_FRAMES = 8;

export const CLOSE_NORMAL = 1000;
export const CLOSE_POLICY = 1008;
export const CLOSE_TOO_BIG = 1009;
export const CLOSE_TRY_AGAIN = 1013;
/** No desktop holds the room, or it did not dial back. Apart from 1013 so the phone can say the PC is unreachable. */
export const CLOSE_DESKTOP_OFFLINE = RemoteCloseCode.desktopOffline;
/** Apart from RemoteCloseCode.protocol (4000), which the desktop and phone use for unreadable frames. */
export const CLOSE_REPLACED = RemoteCloseCode.replaced;
/** Close reasons passed from one side to the other are cut to this, under the 123-byte frame limit. */
export const MAX_PASSED_REASON_BYTES = 120;

/*
 * A socket as the Durable Object knows it after waking from hibernation. The handshake fields come
 * back too, so a pause long enough to hibernate does not reset the caps on an unanswered phone.
 */
export type RestoredSocket =
  | { role: "control"; socket: PipeSocket; claimed: boolean; seenAt?: number | undefined }
  | {
      role: "phone";
      session: string;
      socket: PipeSocket;
      seenAt?: number | undefined;
      unansweredBytes?: number | undefined;
      unansweredFrames?: number | undefined;
    }
  | {
      role: "host";
      session: string;
      socket: PipeSocket;
      seenAt?: number | undefined;
      joinedAt?: number | undefined;
      hostSpoke?: boolean | undefined;
    };

/** What the Durable Object records per session so a wake keeps the handshake caps. */
export interface HandshakeState {
  hostSpoke: boolean;
  unansweredBytes: number;
  unansweredFrames: number;
}

interface Session {
  phone: PipeSocket;
  host: PipeSocket | null;
  /** Frames the phone sent before the desktop dialed in. */
  waiting: Array<string | ArrayBuffer>;
  openedAt: number;
  /** When the desktop dialed in; it must speak within twice the dial timeout after that. */
  joinedAt: number;
  /*
   * When each side last sent a frame. They are kept apart so a phone that went away is cut even while the desktop keeps
   * sending to it, which would otherwise spend the day's budget on nobody.
   */
  phoneSeenAt: number;
  hostSeenAt: number;
  /** Bytes and frames the phone sent before the desktop's first frame. */
  unansweredBytes: number;
  unansweredFrames: number;
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
  readonly #relayBudget: RelayBudget | undefined;
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
  #timer: { handle: unknown; at: number } | null = null;

  constructor(
    roomId: string,
    limits: RoomLimits = DEFAULT_LIMITS,
    clock: RoomClock = systemClock,
    store?: BudgetStore,
    relayBudget?: RelayBudget,
  ) {
    this.#roomId = roomId;
    this.#limits = limits;
    this.#clock = clock;
    this.#store = store;
    this.#relayBudget = relayBudget;
    this.#budget = store?.load() ?? { day: utcDay(clock.now()), count: 0, told: false };
  }

  isHost(socket: PipeSocket): boolean {
    return this.#host === socket;
  }

  /*
   * A new control socket. It must claim within the dial timeout, and only a few may wait. When the
   * slots are full the oldest one goes, not the newcomer: refusing newcomers would let a stranger
   * keep the real desktop out just by refilling the slots.
   */
  controlConnected(socket: PipeSocket): boolean {
    while (this.#unclaimed.size >= MAX_UNCLAIMED_CONTROLS) {
      const [oldest] = this.#unclaimed.keys();
      if (!oldest) break;
      this.#closeControl(oldest, CLOSE_TRY_AGAIN, "Replaced by a newer connection.");
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
    // Told even if an earlier desktop heard it today: this one was not there, and would wait on phones that cannot come.
    if (this.#overBudget()) this.#tellBudget(true);
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

  /*
   * When the runtime last answered this socket's ping for the room. Pings never reach the room, so the Durable Object
   * reads that time and hands it over before the room checks the host. Only moves the clock forward.
   */
  heartbeat(socket: PipeSocket, at: number): void {
    if (this.#closed.has(socket) || !this.isHost(socket)) return;
    this.#hostSeenAt = Math.max(this.#hostSeenAt, at);
  }

  hostControlClosed(socket: PipeSocket): void {
    this.#unclaimed.delete(socket);
    if (this.#host === socket) this.#host = null;
  }

  phoneConnected(socket: PipeSocket, client: string, session: string = newSessionId()): "queued" | "rejected" {
    const host = this.#liveHost();
    const refusal = this.#phoneRefusal(session);
    if (!host) {
      socket.close(CLOSE_DESKTOP_OFFLINE, "The desktop is offline.");
      return "rejected";
    }
    if (this.#relayBudget?.over()) {
      socket.close(CLOSE_TRY_AGAIN, RELAY_LIMIT_REASON);
      return "rejected";
    }
    if (refusal) {
      socket.close(CLOSE_TRY_AGAIN, refusal);
      return "rejected";
    }
    const now = this.#clock.now();
    this.#sessions.set(session, {
      phone: socket,
      host: null,
      waiting: [],
      openedAt: now,
      joinedAt: now,
      phoneSeenAt: now,
      hostSeenAt: now,
      unansweredBytes: 0,
      unansweredFrames: 0,
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
    entry.joinedAt = this.#clock.now();
    entry.hostSeenAt = entry.joinedAt;
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
    // Until the desktop answers, the phone is unauthenticated, so it may only send a handshake.
    const unanswered = from === "phone" && !entry.hostSpoke;
    if (unanswered) {
      entry.unansweredBytes += size;
      entry.unansweredFrames += 1;
      if (entry.unansweredBytes > this.#limits.handshakeBytesCap || entry.unansweredFrames > MAX_HANDSHAKE_FRAMES) {
        this.#endSession(session, entry, CLOSE_POLICY, "Too much data before the desktop answered.");
        return;
      }
    }
    if (from === "host") entry.hostSeenAt = this.#clock.now();
    else entry.phoneSeenAt = this.#clock.now();
    if (from === "host") {
      // This lifts the pre-handshake caps one message before the phone has authenticated: the
      // desktop's first frame is the start of the handshake, not proof that the phone passed it.
      entry.hostSpoke = true;
      entry.phone.send(data);
    } else if (entry.host) {
      entry.host.send(data);
    } else {
      entry.waiting.push(data);
    }
    // Unanswered frames are not counted, or one stranger could spend the room's day.
    if (!unanswered) this.#countFrame();
  }

  handshakeState(session: string): HandshakeState | undefined {
    const entry = this.#sessions.get(session);
    if (!entry) return undefined;
    return {
      hostSpoke: entry.hostSpoke,
      unansweredBytes: entry.unansweredBytes,
      unansweredFrames: entry.unansweredFrames,
    };
  }

  /*
   * An application close code (4000-4999) and its reason go on to the other side, so a phone over
   * the relay still learns it is not paired or that its code expired. They are not authenticated:
   * the phone treats them as hints. Any other code says nothing the far side can act on, so it
   * becomes a plain 1000.
   */
  onClose(from: "phone" | "host", session: string, socket: PipeSocket, code?: number, reason?: string): void {
    const entry = this.#sessions.get(session);
    if (!entry || !isJoined(entry, from, socket)) return;
    const peer = from === "phone" ? entry.host : entry.phone;
    this.#sessions.delete(session);
    if (code !== undefined && Number.isInteger(code) && code >= 4000 && code <= 4999) {
      peer?.close(code, truncateUtf8(reason ?? "", MAX_PASSED_REASON_BYTES));
    } else {
      peer?.close(CLOSE_NORMAL, "The other side left.");
    }
  }

  /*
   * After hibernation the in-memory maps are gone, so the Durable Object hands back every socket
   * with the role and session it was tagged with. Joined pairs carry on. A phone still waiting for
   * its desktop lost its queued frames and dial deadline, so it is closed and can retry, and so is
   * a control socket that had not claimed.
   */
  restore(sockets: readonly RestoredSocket[]): void {
    const now = this.#clock.now();
    const phones = new Map<string, RestoredSocket & { role: "phone" }>();
    const hosts = new Map<string, RestoredSocket & { role: "host" }>();
    for (const item of sockets) {
      const seenAt = item.seenAt ?? now;
      if (item.role === "control") {
        if (item.claimed && !this.#host) {
          this.#host = item.socket;
          this.#hostSeenAt = seenAt;
        } else {
          this.#closeControl(item.socket, CLOSE_TRY_AGAIN, "The relay restarted.");
        }
      } else if (item.role === "phone") {
        phones.set(item.session, item);
      } else {
        hosts.set(item.session, item);
      }
    }
    for (const [session, phone] of phones) {
      const host = hosts.get(session);
      if (host) {
        this.#sessions.set(session, {
          phone: phone.socket,
          host: host.socket,
          waiting: [],
          openedAt: now,
          joinedAt: host.joinedAt ?? now,
          phoneSeenAt: phone.seenAt ?? now,
          hostSeenAt: host.seenAt ?? now,
          unansweredBytes: phone.unansweredBytes ?? 0,
          unansweredFrames: phone.unansweredFrames ?? 0,
          // Unknown means not yet: lifting the caps on a guess would let a pause bypass them.
          hostSpoke: host.hostSpoke === true,
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
        entry.phone.close(CLOSE_DESKTOP_OFFLINE, "The desktop did not answer.");
      } else if (entry.host && !entry.hostSpoke && now - entry.joinedAt >= this.#limits.dialTimeoutMs * 2) {
        // A desktop that dials but never answers would hold the slot while the phone trickles.
        this.#endSession(session, entry, CLOSE_POLICY, "The desktop did not answer.");
      } else if (now - this.#quietSince(entry) >= this.#limits.idleTimeoutMs) {
        this.#endSession(session, entry, CLOSE_NORMAL, "Idle for too long.");
      }
    }
    this.#schedule();
  }

  /*
   * When the quieter side of a session was last heard from. A quiet session gets no frames from the desktop, so its
   * control socket's heartbeat counts for the desktop side: the desktop is still there, it just has nothing to say.
   * The phone has no such channel, so it sends a sealed keepalive that arrives here as an ordinary frame.
   */
  #quietSince(entry: Session): number {
    return Math.min(entry.phoneSeenAt, Math.max(entry.hostSeenAt, this.#hostSeenAt));
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
    if (this.#sessions.has(session)) return "That session is already open.";
    if (this.#overBudget()) return "The daily message budget is used up.";
    let pending = 0;
    for (const entry of this.#sessions.values()) if (!entry.host) pending += 1;
    if (pending >= this.#limits.maxPendingPhones) return "Too many phones are waiting.";
    if (this.#sessions.size >= this.#limits.maxActiveSessions) return "Too many sessions.";
    return null;
  }

  #today(): BudgetState {
    const day = utcDay(this.#clock.now());
    if (this.#budget.day !== day) this.#budget = { day, count: 0, told: false };
    return this.#budget;
  }

  #overBudget(): boolean {
    return this.#today().count >= this.#limits.messagesPerDay;
  }

  #countFrame(): void {
    this.#relayBudget?.counted();
    const budget = this.#today();
    budget.count += 1;
    if (budget.count >= this.#limits.messagesPerDay) this.#tellBudget();
    if (budget.count === 1 || budget.count % BUDGET_SAVE_EVERY === 0) this.#saveBudget();
  }

  /** Tells the host once a day, and each desktop that claims on a used-up day. */
  #tellBudget(claiming = false): void {
    const budget = this.#today();
    if (this.#host && (claiming || !budget.told)) {
      this.#host.send(JSON.stringify({ type: "budget" }));
      budget.told = true;
    }
    this.#saveBudget();
  }

  #saveBudget(): void {
    this.#store?.save(this.#budget);
  }

  #schedule(): void {
    let next = Number.POSITIVE_INFINITY;
    for (const at of this.#unclaimed.values()) next = Math.min(next, at + this.#limits.dialTimeoutMs);
    if (this.#host) next = Math.min(next, this.#hostSeenAt + this.#limits.idleTimeoutMs * 2);
    for (const entry of this.#sessions.values()) {
      next = Math.min(next, this.#quietSince(entry) + this.#limits.idleTimeoutMs);
      if (!entry.host) next = Math.min(next, entry.openedAt + this.#limits.dialTimeoutMs);
      else if (!entry.hostSpoke) next = Math.min(next, entry.joinedAt + this.#limits.dialTimeoutMs * 2);
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

export function utcDay(time: number): string {
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
    else if (code >= 0xd800 && code < 0xdc00 && isLowSurrogate(data.charCodeAt(i + 1))) {
      // A surrogate pair is one four-byte character.
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** The longest prefix of `text` that fits in `max` UTF-8 bytes, never splitting a character. */
function truncateUtf8(text: string, max: number): string {
  if (byteLength(text) <= max) return text;
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    bytes += byteLength(character);
    if (bytes > max) break;
    end += character.length;
  }
  return text.slice(0, end);
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
