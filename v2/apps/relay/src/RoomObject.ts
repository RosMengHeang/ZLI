import { DurableObject } from "cloudflare:workers";

import type { RelayCounter } from "./RelayCounter.js";
import {
  type BudgetState,
  type BudgetStore,
  dailyFramesFrom,
  type HandshakeState,
  limitsFrom,
  newSessionId,
  type PipeSocket,
  type RelayBudget,
  RelayRoom,
  type RestoredSocket,
  type RoomClock,
  type RoomLimits,
} from "./RelayRoom.js";
import { isWebSocketUpgrade, type UpgradeLimiter } from "./routes.js";

export interface Env {
  ROOMS: DurableObjectNamespace<RoomObject>;
  /** The one relay-wide frame counter. */
  COUNTER: DurableObjectNamespace<RelayCounter>;
  /** Frames the whole relay may forward per UTC day. Defaults to 2 000 000. */
  RELAY_DAILY_FRAMES?: string;
  /** Upgrades per connecting address. Absent in local runs. */
  UPGRADES?: UpgradeLimiter;
  /** JSON overrides for RoomLimits. Only the Worker tests set it, to shorten timers. */
  RELAY_TEST_LIMITS?: string;
}

/** Headers the worker sets. Only the worker can reach a Durable Object, so they are trusted. */
export const ROLE_HEADER = "X-Relay-Role";
export const ROOM_HEADER = "X-Relay-Room";
export const SESSION_HEADER = "X-Relay-Session";
export const CLIENT_HEADER = "X-Relay-Client";

const BUDGET_KEY = "budget";
/** Frames a room counts before it reports them to the relay-wide counter. */
const REPORT_EVERY = 64;
/** The runtime answers this itself, without waking the object, so idle desktops cost nothing between sweeps. */
const PING = JSON.stringify({ type: "ping" });
const PONG = JSON.stringify({ type: "pong" });

type Role = "control" | "phone" | "host";

interface Tagged {
  role: Role;
  room: string;
  session: string | undefined;
}

/** What a socket keeps across hibernation besides its tags. */
interface Attachment {
  claimed?: boolean | undefined;
  seenAt?: number | undefined;
  /** Session host only: when it dialed in, and whether it has sent its first frame. */
  joinedAt?: number | undefined;
  hostSpoke?: boolean | undefined;
  /** Phone only: what it sent before the desktop's first frame. */
  unansweredBytes?: number | undefined;
  unansweredFrames?: number | undefined;
}

const NUMBER_FIELDS = ["seenAt", "joinedAt", "unansweredBytes", "unansweredFrames"] as const;

/*
 * A socket as RelayRoom sees it. Until the Durable Object has accepted the socket it only records
 * what the room asked for, so the DO can pick how to accept it once the room has decided.
 */
class SocketPipe implements PipeSocket {
  readonly #ws: WebSocket;
  #accepted: boolean;
  #queued: Array<string | ArrayBuffer> = [];
  closeRequest: { code: number; reason: string | undefined } | null = null;
  /** When `seenAt` was last written to the attachment, to keep those writes rare. */
  seenSavedAt = 0;
  /** The session host's attachment already says it has spoken. */
  spokeSaved = false;

  constructor(ws: WebSocket, accepted: boolean) {
    this.#ws = ws;
    this.#accepted = accepted;
  }

  send(data: string | ArrayBuffer): void {
    if (!this.#accepted) {
      this.#queued.push(data);
      return;
    }
    // Sends and closes on a socket that is already closing throw; the room treats them as no-ops.
    try {
      this.#ws.send(data);
    } catch {}
  }

  close(code: number, reason?: string): void {
    if (!this.#accepted) {
      this.closeRequest ??= { code, reason };
      return;
    }
    try {
      this.#ws.close(code, reason);
    } catch {}
  }

  accepted(): void {
    this.#accepted = true;
    for (const data of this.#queued.splice(0)) this.send(data);
  }
}

/*
 * A thin adapter: it accepts sockets with the Hibernation API and turns their events into RelayRoom
 * calls. Every socket is tagged with its role, room, and session, and its attachment records whether
 * a control socket holds the room and when the socket was last heard from. On wake the RelayRoom in
 * memory is gone, so it is rebuilt from those (see RelayRoom.restore). The room's timers run on the
 * Durable Object alarm, which also wakes a hibernated object, so idle sockets are swept without
 * keeping the object awake.
 */
export class RoomObject extends DurableObject<Env> {
  #room: RelayRoom | null = null;
  readonly #pipes = new WeakMap<WebSocket, SocketPipe>();
  readonly #limits: RoomLimits = limitsFrom(this.env.RELAY_TEST_LIMITS);
  readonly #dailyFrames = dailyFramesFrom(this.env.RELAY_DAILY_FRAMES);
  /** What the relay-wide counter said last. Read again before each phone is let in. */
  #relayOver = false;
  /** Frames counted here and not yet reported. An eviction loses at most REPORT_EVERY - 1 of them. */
  #unreported = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  override async fetch(request: Request): Promise<Response> {
    const role = request.headers.get(ROLE_HEADER);
    const roomId = request.headers.get(ROOM_HEADER);
    const session = role === "phone" ? newSessionId() : request.headers.get(SESSION_HEADER);
    if (!isWebSocketUpgrade(request) || !roomId || !isRole(role) || (role !== "control" && !session)) {
      return new Response("Not found", { status: 404 });
    }
    const room = this.#roomFor(roomId);
    this.#readHeartbeats(room);
    // Only a phone the room could take asks the relay-wide counter, so an empty room costs no call to it.
    if (role === "phone" && room.hasHost()) await this.#checkRelayTotal();
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // The room decides before the socket is accepted.
    const pipe = new SocketPipe(server, false);
    this.#pipes.set(server, pipe);
    if (role === "control") {
      room.controlConnected(pipe);
    } else if (role === "phone" && session) {
      room.phoneConnected(pipe, request.headers.get(CLIENT_HEADER) ?? "unknown", session);
    } else if (role === "host" && session) {
      room.sessionHostConnected(session, pipe);
    }

    if (pipe.closeRequest) {
      // A refused socket gets a plain accept and close. Closing a hibernatable socket whose client
      // has not sent anything yet leaves the client waiting in workerd, so it never learns why.
      server.accept();
      server.close(pipe.closeRequest.code, pipe.closeRequest.reason);
    } else {
      this.ctx.acceptWebSocket(
        server,
        session ? [role, `room:${roomId}`, `session:${session}`] : [role, `room:${roomId}`],
      );
      const now = Date.now();
      server.serializeAttachment(
        (role === "host" ? { seenAt: now, joinedAt: now } : { claimed: false, seenAt: now }) satisfies Attachment,
      );
      pipe.seenSavedAt = now;
      pipe.accepted();
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const tagged = this.#tagged(ws);
    if (!tagged) return;
    const room = this.#roomFor(tagged.room);
    const pipe = this.#pipe(ws);
    if (tagged.role === "control") {
      const wasHost = room.isHost(pipe);
      room.hostControl(pipe, message);
      if (room.isHost(pipe) !== wasHost) this.#saveClaims(room);
      // Claims and heartbeats are rare, so each one is recorded for the host liveness clock.
      if (room.isHost(pipe)) ws.serializeAttachment({ claimed: true, seenAt: Date.now() } satisfies Attachment);
    } else if (tagged.session) {
      room.onFrame(tagged.role, tagged.session, message, pipe);
      this.#recordFrame(ws, pipe, tagged.role, room.handshakeState(tagged.session));
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.#closed(ws, code, reason);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.#closed(ws);
  }

  override async alarm(): Promise<void> {
    const room = this.#room ?? this.#wakeRoom();
    if (!room) return;
    this.#readHeartbeats(room);
    this.#report();
    room.sweep();
    // A sweep can drop a host that stopped sending heartbeats; a later wake must not restore it.
    this.#saveClaims(room);
  }

  /*
   * Keeps what a wake needs. Handshake progress is written on every unanswered phone frame (at most
   * eight) and once when the session host first speaks, so pausing until the object hibernates
   * cannot reset the caps. Plain activity is written rarely, since idle closes can be a little early.
   */
  #recordFrame(ws: WebSocket, pipe: SocketPipe, role: "phone" | "host", state: HandshakeState | undefined): void {
    if (!state) return;
    const now = Date.now();
    let patch: Attachment | null = null;
    if (role === "phone" && !state.hostSpoke) {
      patch = { unansweredBytes: state.unansweredBytes, unansweredFrames: state.unansweredFrames };
    } else if (role === "host" && state.hostSpoke && !pipe.spokeSaved) {
      patch = { hostSpoke: true };
      pipe.spokeSaved = true;
    }
    if (!patch && now - pipe.seenSavedAt < this.#limits.idleTimeoutMs / 10) return;
    ws.serializeAttachment({ ...readAttachment(ws), ...patch, seenAt: now } satisfies Attachment);
    pipe.seenSavedAt = now;
  }

  #closed(ws: WebSocket, code?: number, reason?: string): void {
    const tagged = this.#tagged(ws);
    if (!tagged) return;
    const room = this.#roomFor(tagged.room);
    const pipe = this.#pipe(ws);
    if (tagged.role === "control") room.hostControlClosed(pipe);
    else if (tagged.session) room.onClose(tagged.role, tagged.session, pipe, code, reason);
  }

  /** Rebuilds the room after a wake that did not come with a request naming it. */
  #wakeRoom(): RelayRoom | null {
    for (const ws of this.ctx.getWebSockets()) {
      const tagged = this.#tagged(ws);
      if (tagged) return this.#roomFor(tagged.room);
    }
    return null;
  }

  #roomFor(roomId: string): RelayRoom {
    if (this.#room) return this.#room;
    const room = new RelayRoom(roomId, this.#limits, this.#alarmClock(), this.#budgetStore(), this.#relayBudget());
    const restored: RestoredSocket[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const tagged = this.#tagged(ws);
      if (!tagged) continue;
      const socket = this.#pipe(ws);
      const attachment = readAttachment(ws);
      if (tagged.role === "control") {
        restored.push({ role: "control", socket, claimed: attachment.claimed === true, seenAt: attachment.seenAt });
      } else if (tagged.role === "phone" && tagged.session) {
        restored.push({
          role: "phone",
          session: tagged.session,
          socket,
          seenAt: attachment.seenAt,
          unansweredBytes: attachment.unansweredBytes,
          unansweredFrames: attachment.unansweredFrames,
        });
      } else if (tagged.session) {
        if (attachment.hostSpoke === true) socket.spokeSaved = true;
        restored.push({
          role: "host",
          session: tagged.session,
          socket,
          seenAt: attachment.seenAt,
          joinedAt: attachment.joinedAt,
          hostSpoke: attachment.hostSpoke === true,
        });
      }
    }
    this.#room = room;
    room.restore(restored);
    return room;
  }

  /** Hands the room the last time the runtime answered each control socket's ping. */
  #readHeartbeats(room: RelayRoom): void {
    for (const ws of this.ctx.getWebSockets("control")) {
      const at = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      if (at) room.heartbeat(this.#pipe(ws), at.getTime());
    }
  }

  #counter(): DurableObjectStub<RelayCounter> {
    return this.env.COUNTER.get(this.env.COUNTER.idFromName("relay"));
  }

  #relayBudget(): RelayBudget {
    return {
      over: () => this.#relayOver,
      counted: () => {
        this.#unreported += 1;
        if (this.#unreported >= REPORT_EVERY) this.#report();
      },
    };
  }

  /** Sends the unreported frames to the counter without waiting on it. */
  #report(): void {
    const frames = this.#unreported;
    if (frames === 0) return;
    this.#unreported = 0;
    this.#counter()
      .add(frames)
      .then((total) => {
        this.#relayOver = total >= this.#dailyFrames;
      })
      .catch(() => {
        this.#unreported += frames;
      });
  }

  /** A counter that cannot be reached leaves the last answer in place, so an outage there does not close the relay. */
  async #checkRelayTotal(): Promise<void> {
    try {
      this.#relayOver = (await this.#counter().total()) >= this.#dailyFrames;
    } catch {}
  }

  /** The room keeps a single timer, so it maps onto the one alarm a Durable Object has. */
  #alarmClock(): RoomClock {
    const storage = this.ctx.storage;
    return {
      now: () => Date.now(),
      setTimer: (_run, ms) => {
        void storage.setAlarm(Date.now() + ms);
        return null;
      },
      clearTimer: () => {
        void storage.deleteAlarm();
      },
    };
  }

  #budgetStore(): BudgetStore {
    const kv = this.ctx.storage.kv;
    return {
      load: () => readBudget(kv.get(BUDGET_KEY)),
      save: (state) => kv.put(BUDGET_KEY, state),
    };
  }

  /** Marks which control socket holds the room, so a wake does not hand it to a replaced one. */
  #saveClaims(room: RelayRoom): void {
    for (const ws of this.ctx.getWebSockets("control")) {
      const claimed = room.isHost(this.#pipe(ws));
      ws.serializeAttachment({ claimed, seenAt: readAttachment(ws).seenAt } satisfies Attachment);
    }
  }

  #tagged(ws: WebSocket): Tagged | null {
    const tags = this.ctx.getTags(ws);
    const role = tags[0];
    const room = tagValue(tags, "room:");
    if (!isRole(role) || !room) return null;
    return { role, room, session: tagValue(tags, "session:") };
  }

  /** The pipe for a socket the runtime already accepted (the map is empty again after a wake). */
  #pipe(ws: WebSocket): SocketPipe {
    let pipe = this.#pipes.get(ws);
    if (!pipe) {
      pipe = new SocketPipe(ws, true);
      this.#pipes.set(ws, pipe);
    }
    return pipe;
  }
}

function isRole(value: string | null | undefined): value is Role {
  return value === "control" || value === "phone" || value === "host";
}

function tagValue(tags: readonly string[], prefix: string): string | undefined {
  return tags.find((tag) => tag.startsWith(prefix))?.slice(prefix.length);
}

function readAttachment(ws: WebSocket): Attachment {
  const value: unknown = ws.deserializeAttachment();
  if (typeof value !== "object" || value === null) return {};
  const record = value as Record<string, unknown>;
  const attachment: Attachment = {};
  if (record.claimed === true) attachment.claimed = true;
  if (record.hostSpoke === true) attachment.hostSpoke = true;
  for (const field of NUMBER_FIELDS) {
    const number = record[field];
    if (typeof number === "number") attachment[field] = number;
  }
  return attachment;
}

function readBudget(value: unknown): BudgetState | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { day, count, told } = value as Record<string, unknown>;
  if (typeof day !== "string" || typeof count !== "number" || typeof told !== "boolean") return undefined;
  return { day, count, told };
}
