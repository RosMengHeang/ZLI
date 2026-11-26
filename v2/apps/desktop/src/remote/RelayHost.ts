import { RelayHostMessage, type RelayRoute, relayUrl, toBase64Url } from "@zli-v2/remote-protocol";
import type { WebSocket } from "ws";

import { type MobileGateway, PHONE_SOCKET_OPTIONS } from "./MobileGateway.js";

export type RelayState = "off" | "connecting" | "online" | "offline" | "budget-exhausted" | "replaced";

export interface RelayHostOptions {
  readonly route: RelayRoute;
  readonly secret: Uint8Array;
  readonly gateway: Pick<MobileGateway, "accept">;
  /** Always called with PHONE_SOCKET_OPTIONS, so the frame cap and no-compression rules hold on every relay socket. */
  readonly createSocket: (url: string, options: typeof PHONE_SOCKET_OPTIONS) => WebSocket;
  readonly onState: (state: RelayState) => void;
  readonly now?: () => number;
  readonly random?: () => number;
}

const PING_MS = 20_000;
const BACKOFF_FIRST_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const MAX_SESSIONS = 8;
/** The control channel only carries small JSON, so anything bigger is not the relay speaking. */
const MAX_CONTROL_BYTES = 4096;
const CLOSE_TOO_BIG = 1009;
const CLOSE_REJECTED = 1008;
/** The relay closes the older desktop with this when a second one claims the room. */
const CLOSE_REPLACED = 4000;
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
  #pingTimer: ReturnType<typeof setInterval> | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #attempt = 0;
  #missedPongs = 0;
  #stableTimer: ReturnType<typeof setTimeout> | undefined;
  #controlDeadline: ReturnType<typeof setTimeout> | undefined;
  readonly #sessionDeadlines = new Map<WebSocket, ReturnType<typeof setTimeout>>();

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
    this.#clearPing();
    clearTimeout(this.#controlDeadline);
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
      socket = createSocket(relayUrl(route, "host"), PHONE_SOCKET_OPTIONS);
    } catch {
      // Nothing escapes a timer callback, so a failed dial is treated like a dropped link.
      this.#setState("offline");
      this.#schedule(this.#backoff());
      return;
    }
    this.#control = socket;
    this.#controlDeadline = deadline(socket);
    // A failed dial or dropped link is handled by the close that follows.
    socket.on("error", () => undefined);
    socket.on("pong", () => {
      this.#missedPongs = 0;
    });
    socket.on("open", () => {
      if (this.#control !== socket) return;
      clearTimeout(this.#controlDeadline);
      socket.send(JSON.stringify({ type: "claim", secret: toBase64Url(secret) }));
      this.#missedPongs = 0;
      this.#pingTimer = setInterval(() => {
        if (socket.readyState !== 1) return;
        // The relay only counts our app pings, and a dead path would never tell us otherwise.
        if (this.#missedPongs >= 2) {
          socket.terminate();
          return;
        }
        this.#missedPongs += 1;
        socket.ping();
        socket.send(JSON.stringify({ type: "ping" }));
      }, PING_MS);
      // A relay that rejects the claim closes right after open, so only a link that holds earns a fresh backoff.
      this.#stableTimer = setTimeout(() => {
        this.#attempt = 0;
      }, STABLE_MS);
      this.#setState("online");
    });
    socket.on("message", (data, isBinary) => {
      if (this.#control === socket) this.#onControlMessage(socket, data, isBinary);
    });
    socket.on("close", (code: number) => {
      clearTimeout(this.#controlDeadline);
      if (this.#control !== socket) return;
      this.#control = undefined;
      this.#clearPing();
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
  }

  #openSession(session: string, client: string): void {
    if (this.#sessions.size >= MAX_SESSIONS) return;
    const { route, gateway, createSocket } = this.#options;
    const socket = createSocket(relayUrl(route, "host", session), PHONE_SOCKET_OPTIONS);
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
    this.#clearPing();
    clearTimeout(this.#controlDeadline);
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

  #clearPing(): void {
    clearTimeout(this.#stableTimer);
    this.#stableTimer = undefined;
    clearInterval(this.#pingTimer);
    this.#pingTimer = undefined;
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
