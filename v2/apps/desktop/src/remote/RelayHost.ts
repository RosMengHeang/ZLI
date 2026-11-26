import { RelayHostMessage, type RelayRoute, RemoteCloseCode, relayUrl, toBase64Url } from "@zli-v2/remote-protocol";
import type { WebSocket } from "ws";

import { type MobileGateway, PHONE_SOCKET_OPTIONS } from "./MobileGateway.js";

export type RelayState = "off" | "connecting" | "online" | "offline" | "budget-exhausted" | "replaced";

export interface RelayHostOptions {
  readonly route: RelayRoute;
  readonly secret: Uint8Array;
  readonly gateway: Pick<MobileGateway, "accept">;
  /**
   * Called with PHONE_SOCKET_OPTIONS for session sockets and CONTROL_SOCKET_OPTIONS for the control socket, so a frame
   * cap and no compression hold on every relay socket.
   */
  readonly createSocket: (url: string, options: RelaySocketOptions) => WebSocket;
  readonly onState: (state: RelayState) => void;
  readonly now?: () => number;
  readonly random?: () => number;
  /** How often to ping the relay. Tests with a short relay idle limit shorten it. */
  readonly pingMs?: number;
}

export type RelaySocketOptions = { readonly maxPayload: number; readonly perMessageDeflate: false };

const PING_MS = 20_000;
const BACKOFF_FIRST_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const MAX_SESSIONS = 8;
/** The control channel only carries small JSON, so anything bigger is not the relay speaking. */
const MAX_CONTROL_BYTES = 4096;
/** ws refuses a bigger control frame before buffering it, so the size check below is only a second line. */
export const CONTROL_SOCKET_OPTIONS: RelaySocketOptions = { ...PHONE_SOCKET_OPTIONS, maxPayload: MAX_CONTROL_BYTES };
const CLOSE_TOO_BIG = 1009;
const CLOSE_REJECTED = 1008;
/** The relay closes the older desktop with this when a second one claims the room. */
const CLOSE_REPLACED = RemoteCloseCode.replaced;
const STABLE_MS = 30_000;
const CONNECT_DEADLINE_MS = 15_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const BUDGET_JITTER_MS = 5 * 60 * 1000;

/**
 * Keeps one outbound control socket to the relay and, for each phone the relay announces, dials a session socket back
 * and gives it to the gateway. It opens no listening port. Nothing is logged: URLs carry the room id and frames are
 * private.
 */
export class RelayHost {
  readonly #options: RelayHostOptions;
  readonly #sessions = new Set<WebSocket>();
  #running = false;
  #state: RelayState = "off";
  #control: WebSocket | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #attempt = 0;
  /** Cancels the timers of the current control socket. Each socket owns its own, so a stale one cannot touch them. */
  #releaseControl: (() => void) | undefined;
  readonly #sessionDeadlines = new Map<WebSocket, ReturnType<typeof setTimeout>>();
  /** Resets the current control socket's missed-pong count. */
  #onPong: (() => void) | undefined;

  constructor(options: RelayHostOptions) {
    this.#options = options;
    // Fails here, not on a timer later, if the route is bad.
    relayUrl(options.route, "host");
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#attempt = 0;
    this.#connect();
  }

  stop(): void {
    this.#running = false;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#releaseControl?.();
    for (const timer of this.#sessionDeadlines.values()) clearTimeout(timer);
    this.#sessionDeadlines.clear();
    const control = this.#control;
    this.#control = undefined;
    closeSocket(control);
    for (const socket of [...this.#sessions]) closeSocket(socket);
    this.#sessions.clear();
    this.#setState("off");
  }

  #setState(state: RelayState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#options.onState(state);
  }

  #connect(): void {
    this.#retryTimer = undefined;
    this.#setState("connecting");
    const { route, secret, createSocket } = this.#options;
    let socket: WebSocket;
    try {
      socket = createSocket(relayUrl(route, "host"), CONTROL_SOCKET_OPTIONS);
    } catch {
      // Nothing escapes a timer callback, so a failed dial is treated like a dropped link.
      this.#setState("offline");
      this.#schedule(this.#backoff());
      return;
    }
    this.#control = socket;
    let missedPongs = 0;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let stableTimer: ReturnType<typeof setTimeout> | undefined;
    const connectDeadline = deadline(socket);
    const release = () => {
      clearTimeout(connectDeadline);
      clearInterval(pingTimer);
      clearTimeout(stableTimer);
    };
    this.#releaseControl = release;
    // A failed dial or dropped link is handled by the close that follows.
    socket.on("error", () => undefined);
    socket.on("pong", () => {
      missedPongs = 0;
    });
    // The relay answers the app ping too, and that answer comes from further along the path than a protocol pong.
    this.#onPong = () => {
      missedPongs = 0;
    };
    socket.on("open", () => {
      if (this.#control !== socket) return;
      clearTimeout(connectDeadline);
      socket.send(JSON.stringify({ type: "claim", secret: toBase64Url(secret) }));
      pingTimer = setInterval(() => {
        if (socket.readyState !== 1) return;
        // The relay only counts our app pings, and a dead path would never tell us otherwise.
        if (missedPongs >= 2) {
          socket.terminate();
          return;
        }
        missedPongs += 1;
        socket.ping();
        socket.send(JSON.stringify({ type: "ping" }));
      }, this.#options.pingMs ?? PING_MS);
      // A relay that rejects the claim closes right after open, so only a link that holds earns a fresh backoff.
      stableTimer = setTimeout(() => {
        if (this.#control === socket) this.#attempt = 0;
      }, STABLE_MS);
      this.#setState("online");
    });
    socket.on("message", (data, isBinary) => {
      if (this.#control === socket) this.#onControlMessage(socket, data, isBinary);
    });
    socket.on("close", (code: number) => {
      release();
      if (this.#control !== socket) return;
      this.#control = undefined;
      // After a budget message the wait is already scheduled, and the relay closing is expected.
      if (!this.#running || this.#state === "budget-exhausted") return;
      if (code === CLOSE_REPLACED) {
        // Another desktop owns the room. Retrying would only evict it back and forth.
        this.#setState("replaced");
        return;
      }
      this.#setState("offline");
      const delay = this.#backoff();
      this.#schedule(code === CLOSE_REJECTED ? Math.max(delay, BACKOFF_MAX_MS) : delay);
    });
  }

  #onControlMessage(socket: WebSocket, data: unknown, isBinary: boolean): void {
    if (isBinary || byteLength(data) > MAX_CONTROL_BYTES) {
      socket.close(CLOSE_TOO_BIG);
      return;
    }
    let message: RelayHostMessage;
    try {
      const parsed = RelayHostMessage.safeParse(JSON.parse(String(data)));
      if (!parsed.success) return;
      message = parsed.data;
    } catch {
      return;
    }
    if (message.type === "open") this.#openSession(message.session, message.client);
    else if (message.type === "budget") this.#onBudget(socket);
    else if (message.type === "pong") this.#onPong?.();
  }

  #openSession(session: string, client: string): void {
    if (this.#sessions.size >= MAX_SESSIONS) return;
    const { route, gateway, createSocket } = this.#options;
    let socket: WebSocket;
    try {
      socket = createSocket(relayUrl(route, "host", session), PHONE_SOCKET_OPTIONS);
    } catch {
      // This phone just gets no session; the control link is unaffected.
      return;
    }
    this.#sessions.add(socket);
    this.#sessionDeadlines.set(socket, deadline(socket));
    // The gateway adds its own error handler once it owns the socket; until then an unheard error would throw.
    socket.on("error", () => undefined);
    socket.once("open", () => {
      this.#clearDeadline(socket);
      // Handed over only when open: the gateway pings the socket, which throws on one still connecting.
      if (!this.#sessions.has(socket) || !this.#running) return;
      gateway.accept(socket, { route: "relay", client });
    });
    // When the phone leaves, the relay closes this socket, which is how the gateway learns the phone is gone.
    socket.once("close", () => {
      this.#clearDeadline(socket);
      this.#sessions.delete(socket);
    });
  }

  #clearDeadline(socket: WebSocket): void {
    clearTimeout(this.#sessionDeadlines.get(socket));
    this.#sessionDeadlines.delete(socket);
  }

  #onBudget(socket: WebSocket): void {
    this.#setState("budget-exhausted");
    this.#releaseControl?.();
    // Detached first, so nothing the closing socket still says is acted on.
    this.#control = undefined;
    // Retrying earlier only burns the relay's budget on reconnects, so wait out the UTC day.
    const now = this.#now();
    const untilMidnight = DAY_MS - (now % DAY_MS);
    this.#schedule(untilMidnight + this.#random() * BUDGET_JITTER_MS);
    socket.close();
  }

  #schedule(delay: number): void {
    clearTimeout(this.#retryTimer);
    this.#retryTimer = setTimeout(() => {
      if (this.#running) this.#connect();
    }, delay);
  }

  #backoff(): number {
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** this.#attempt);
    this.#attempt += 1;
    return Math.min(BACKOFF_MAX_MS, base * (0.5 + this.#random()));
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  #random(): number {
    return (this.#options.random ?? Math.random)();
  }
}

/** A relay that never finishes the upgrade would otherwise hold the socket, and a session slot, forever. */
function deadline(socket: WebSocket): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    if (socket.readyState !== 1) socket.terminate();
  }, CONNECT_DEADLINE_MS);
}

function byteLength(data: unknown): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (Array.isArray(data)) return data.reduce((sum: number, part) => sum + byteLength(part), 0);
  if (data instanceof ArrayBuffer) return data.byteLength;
  return (data as { length?: number }).length ?? 0;
}

function closeSocket(socket: WebSocket | undefined): void {
  if (!socket) return;
  // 0 is still connecting, where close() would only raise an error event.
  if (socket.readyState === 1) socket.close(1001);
  else if (socket.readyState === 0) socket.terminate();
}
