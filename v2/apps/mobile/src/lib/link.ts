import { RuntimeClient, type TerminalClientMessage } from "@zli-v2/client-runtime";
import type { RpcResponse, RuntimeProjection } from "@zli-v2/contracts";
import {
  type ClientControl,
  type CreateWebSocket,
  credentialBytes,
  failureMessage,
  fromBase64Url,
  keyPairFromSecret,
  openRemoteSession,
  type RandomBytes,
  type RemoteCloseInfo,
  RemoteConnectError,
  type RemoteFailure,
  type RemoteSession,
  type RemoteTransport,
} from "@zli-v2/remote-protocol";

import { hostsToTry, type StoredPairing, samePairing, withReady } from "./pairingRecord.js";
import type { PushRegistration } from "./push.js";
import {
  blockingRouteFailures,
  LAN_OPEN_TIMEOUT_MS,
  RELAY_UNREACHABLE_MESSAGE,
  RouteFailure,
  type RouteKind,
  raceRoutes,
} from "./routes.js";

/**
 * The gateway answers the runtime hello itself and never forwards it, so the phone holds no runtime
 * token. RuntimeClient still requires a non-empty one.
 */
const PHONE_TOKEN = "paired-phone";

const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000];
const RATE_LIMIT_DELAY_MS = 60_000;
const HELLO_TIMEOUT_MS = 10_000;
/** A connection that drops sooner than this counts as a failed attempt, so a flapping desktop backs off. */
const STABLE_CONNECTION_MS = 5_000;
/** While online over the relay, how often the phone checks whether the desktop is on its network again. */
const LAN_PROBE_MS = 60_000;

export type LinkState =
  | { kind: "connecting"; attempt: number }
  /** `host` is the LAN address that answered; a relay connection has none. */
  | { kind: "online"; host?: string }
  | { kind: "offline"; failure: RemoteFailure; message: string; retryAt: number }
  /** The desktop forgot this phone or could not prove its identity. Only pairing again helps. */
  | { kind: "blocked"; message: string }
  | { kind: "paused" };

export type LinkSnapshot = {
  readonly state: LinkState;
  /** The last projection seen. It stays while reconnecting so screens keep their content. */
  readonly projection: RuntimeProjection | undefined;
  /** Goes up with every new connection, so screens know to attach terminals again. */
  readonly generation: number;
  readonly pairing: StoredPairing;
  /** How the current connection was made, so screens can say "away from home". */
  readonly route: RouteKind | undefined;
};

export type LinkOptions = {
  pairing: StoredPairing;
  random: RandomBytes;
  createSocket: CreateWebSocket;
  newId: () => string;
  onPairingChange?: (pairing: StoredPairing) => void;
  now?: () => number;
  openSession?: typeof openRemoteSession;
  /**
   * Where the desktop can push alerts while the phone is not connected. Undefined when this build
   * cannot receive push notifications, and then nothing is sent.
   */
  pushRegistration?: () => Promise<PushRegistration | undefined>;
  /** How often to look for the desktop on the LAN while online over the relay. Tests shorten it. */
  lanProbeMs?: number;
};

type Online = {
  kind: "online";
  closed: Promise<RemoteCloseInfo | undefined>;
  openedAt: number;
  route: RouteKind;
  /** Closes this connection without it counting as a drop. */
  end: () => void;
};

type Attempt =
  | Online
  | { kind: "failed"; failure: RemoteFailure; message?: string }
  | { kind: "blocked"; message: string }
  | { kind: "stopped" };

const blockingFailures = new Set<RemoteFailure>(["not-paired", "handshake"]);

/** Keeps one encrypted connection to the paired desktop alive and exposes the runtime through it. */
export class RemoteLink {
  readonly #options: LinkOptions;
  readonly #listeners = new Set<() => void>();
  readonly #terminalListeners = new Set<(message: TerminalClientMessage) => void>();
  readonly #now: () => number;
  #snapshot: LinkSnapshot;
  #client: RuntimeClient | undefined;
  /** The current connection, when its desktop takes push and away messages. */
  #controls: RemoteTransport | undefined;
  #away = false;
  #endConnection: (() => void) | undefined;
  /** Aborts the route race in flight, for `pause`. */
  #stopRace: AbortController | undefined;
  #wake: (() => void) | undefined;
  #running = false;
  #loop: Promise<void> | undefined;

  constructor(options: LinkOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#snapshot = {
      state: { kind: "paused" },
      projection: undefined,
      generation: 0,
      pairing: options.pairing,
      route: undefined,
    };
  }

  getSnapshot = (): LinkSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  subscribeTerminal(listener: (message: TerminalClientMessage) => void): () => void {
    this.#terminalListeners.add(listener);
    return () => this.#terminalListeners.delete(listener);
  }

  start(): void {
    if (this.#snapshot.state.kind === "blocked") return;
    if (this.#running) {
      this.retryNow();
      return;
    }
    this.#running = true;
    const previous = this.#loop ?? Promise.resolve();
    this.#loop = previous.then(() => this.#run());
  }

  /** Closes the connection, for when the app goes to the background. `start` opens it again. */
  pause(): void {
    if (!this.#running) return;
    this.#running = false;
    this.#endConnection?.();
    this.#stopRace?.abort();
    this.#wake?.();
    if (this.#snapshot.state.kind !== "blocked") this.#update({ state: { kind: "paused" } });
  }

  /** Skips the wait before the next attempt. */
  retryNow(): void {
    this.#wake?.();
  }

  /** Resolves when the connection loop has wound down after `pause`. */
  async settled(): Promise<void> {
    await this.#loop;
  }

  async command(command: Record<string, unknown> & { type: string }): Promise<RpcResponse> {
    const client = this.#client;
    if (!client || this.#snapshot.state.kind !== "online") {
      throw new Error("Not connected to the desktop.");
    }
    return client.command({ protocolVersion: 1, commandId: this.#options.newId(), command });
  }

  attachTerminal(terminalId: string, afterSequence = 0): void {
    this.#client?.attachTerminal(terminalId, afterSequence);
  }

  /**
   * Tells the desktop the app left the screen and will be suspended, so it pushes alerts instead of
   * waiting to notice the connection went quiet. Kept for later connections until it changes.
   */
  setAway(away: boolean): void {
    if (this.#away === away) return;
    this.#away = away;
    if (this.#controls) this.#sendControl(this.#controls, { type: "gateway.away", away });
  }

  /** Sends the push token again, for when notification permission may have changed. */
  refreshPush(): void {
    if (this.#controls) void this.#sendPush(this.#controls);
  }

  #sendControl(transport: RemoteTransport, message: ClientControl): void {
    try {
      transport.send(message);
    } catch {
      // A closing connection; the next one sends its own.
    }
  }

  async #sendPush(transport: RemoteTransport): Promise<void> {
    const register = this.#options.pushRegistration;
    if (!register) return;
    let registration: PushRegistration | undefined;
    try {
      registration = await register();
    } catch {
      // Push is optional; the app works the same without it.
      return;
    }
    if (registration && this.#controls === transport) {
      this.#sendControl(transport, { type: "gateway.push", ...registration });
    }
  }

  #update(patch: Partial<LinkSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }

  async #run(): Promise<void> {
    let attempt = 0;
    while (this.#running) {
      this.#update({ state: { kind: "connecting", attempt } });
      const result = await this.#connectOnce();
      if (result.kind === "stopped" || !this.#running) break;
      if (result.kind === "blocked") {
        this.#block(result.message);
        break;
      }
      let failure: RemoteFailure;
      let message: string | undefined;
      if (result.kind === "online") {
        let current = result;
        // Over the relay, a LAN session found in the background takes over, and the loop follows it.
        for (let next = await this.#probeLan(current); next; next = await this.#probeLan(current)) current = next;
        const info = await current.closed;
        if (!this.#running) break;
        const relayBlocked = info !== undefined && blockingFailures.has(info.failure) && current.route === "relay";
        if (info && blockingFailures.has(info.failure) && !relayBlocked) {
          this.#block(failureMessage(info.failure));
          break;
        }
        // A relay can close with any code, so its "not paired" is shown but never trusted.
        const stable = !relayBlocked && this.#now() - current.openedAt >= STABLE_CONNECTION_MS;
        attempt = stable ? 0 : attempt + 1;
        if (stable) continue;
        failure = info?.failure ?? "network";
      } else {
        attempt += 1;
        failure = result.failure;
        message = result.message;
      }
      const delay =
        failure === "rate-limited"
          ? RATE_LIMIT_DELAY_MS
          : (RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length) - 1] ?? 1_000);
      this.#update({
        state: { kind: "offline", failure, message: message ?? failureMessage(failure), retryAt: this.#now() + delay },
      });
      await this.#sleep(delay);
    }
  }

  #block(message: string): void {
    this.#running = false;
    this.#update({ state: { kind: "blocked", message } });
  }

  #sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (this.#wake === done) this.#wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, milliseconds);
      this.#wake = done;
    });
  }

  async #connectOnce(): Promise<Attempt> {
    const pairing = this.#snapshot.pairing;
    const stop = new AbortController();
    this.#stopRace = stop;
    let won: Awaited<ReturnType<typeof raceRoutes>>;
    try {
      won = await raceRoutes({
        lanHosts: hostsToTry(pairing),
        port: pairing.port,
        relay: pairing.relay,
        lastRoute: pairing.lastRoute,
        signal: stop.signal,
        open: this.#opener(pairing),
      });
    } catch (error) {
      if (!this.#running) return { kind: "stopped" };
      if (!(error instanceof RemoteConnectError)) throw error;
      if (blockingRouteFailures.has(error.failure)) {
        // Only the LAN can prove this phone was forgotten; a relay can say anything, so keep retrying.
        if (error instanceof RouteFailure && error.route === "relay")
          return { kind: "failed", failure: error.failure, message: error.message };
        return { kind: "blocked", message: error.message };
      }
      if (error.failure === "rate-limited") return { kind: "failed", failure: "rate-limited" };
      // With a relay, "same network" advice would mislead: the phone tried the internet too.
      if (pairing.relay && (error.failure === "network" || error.failure === "timeout")) {
        return { kind: "failed", failure: error.failure, message: RELAY_UNREACHABLE_MESSAGE };
      }
      return { kind: "failed", failure: error.failure };
    } finally {
      if (this.#stopRace === stop) this.#stopRace = undefined;
    }
    if (!this.#running) {
      won.session.transport.close();
      return { kind: "stopped" };
    }
    // A runtime hello that fails after a win retries the whole race, not just the next host.
    const online = await this.#adopt(won.session, won.route, won.host);
    return online ?? { kind: "failed", failure: "protocol" };
  }

  /** Opens one resume session. A LAN socket gets a short deadline to open, so a dead address is passed over quickly. */
  #opener(pairing: StoredPairing): (url: string, signal: AbortSignal, route: RouteKind) => Promise<RemoteSession> {
    const open = this.#options.openSession ?? openRemoteSession;
    return (url, signal, route) =>
      open({
        url,
        serverPublicKey: fromBase64Url(pairing.desktopKey),
        clientStatic: keyPairFromSecret(fromBase64Url(pairing.phoneSecret)),
        target: { mode: "resume", deviceId: pairing.deviceId, credential: credentialBytes(pairing.credential) },
        random: this.#options.random,
        createSocket: this.#options.createSocket,
        timeoutMs: 8_000,
        ...(route === "lan" ? { openTimeoutMs: LAN_OPEN_TIMEOUT_MS } : {}),
        signal,
      });
  }

  /**
   * While `current` runs over the relay, tries the LAN hosts every LAN_PROBE_MS. When one answers, its session becomes
   * the connection and the relay one is closed. Resolves with the new connection, or undefined once `current` closes
   * or when it is not a relay connection.
   */
  async #probeLan(current: Online): Promise<Online | undefined> {
    if (current.route !== "relay") return undefined;
    let open = true;
    const stop = new AbortController();
    void current.closed.then(() => {
      open = false;
      stop.abort();
    });
    const probeMs = this.#options.lanProbeMs ?? LAN_PROBE_MS;
    while (open && this.#running) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        new Promise((resolve) => {
          timer = setTimeout(resolve, probeMs);
        }),
        current.closed,
      ]);
      clearTimeout(timer);
      if (!open || !this.#running) return undefined;
      const pairing = this.#snapshot.pairing;
      const lanHosts = hostsToTry(pairing);
      let won: Awaited<ReturnType<typeof raceRoutes>>;
      try {
        won = await raceRoutes({ lanHosts, port: pairing.port, signal: stop.signal, open: this.#opener(pairing) });
      } catch {
        // Still away from home; the relay connection carries on.
        continue;
      }
      if (!open || !this.#running) {
        won.session.transport.close();
        return undefined;
      }
      const next = await this.#adopt(won.session, "lan", won.host);
      if (!next) continue;
      current.end();
      return next;
    }
    return undefined;
  }

  /** Runs the runtime handshake over a fresh session and makes it the current connection. */
  async #adopt(session: RemoteSession, route: RouteKind, host: string | undefined): Promise<Online | undefined> {
    let resolveClosed!: (info: RemoteCloseInfo | undefined) => void;
    const closed = new Promise<RemoteCloseInfo | undefined>((resolve) => {
      resolveClosed = resolve;
    });
    session.transport.onClose((info) => resolveClosed(info));
    const end = () => {
      resolveClosed(undefined);
      session.transport.close();
    };
    // A connection being replaced stays up until this one is ready, so a pause meanwhile closes both.
    const previous = this.#endConnection;
    this.#endConnection = previous
      ? () => {
          previous();
          end();
        }
      : end;

    let client: RuntimeClient;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      client = await Promise.race([
        RuntimeClient.connect({
          token: PHONE_TOKEN,
          environmentId: session.ready.environmentId,
          connectTransport: async () => session.transport,
          // Each connection gets its own client; this link decides when and where to reconnect.
          reconnectDelaysMs: [],
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("runtime hello timed out")), HELLO_TIMEOUT_MS);
        }),
        closed.then(() => Promise.reject(new Error("closed during runtime hello"))),
      ]);
    } catch {
      session.transport.close();
      this.#endConnection = previous;
      return undefined;
    } finally {
      clearTimeout(timer);
    }

    this.#client = client;
    this.#endConnection = end;
    const current = client.projection();
    if (current) this.#update({ projection: current });
    const stopProjection = client.subscribe((projection) => this.#update({ projection }));
    const stopTerminal = client.subscribeTerminal((message) => {
      for (const listener of this.#terminalListeners) listener(message);
    });
    const pairing = withReady(this.#snapshot.pairing, session.ready, host, route);
    const pairingChanged = !samePairing(pairing, this.#snapshot.pairing);
    this.#update({
      state: host === undefined ? { kind: "online" } : { kind: "online", host },
      generation: this.#snapshot.generation + 1,
      pairing,
      route,
    });
    if (pairingChanged) this.#options.onPairingChange?.(pairing);
    // The connection this one replaces is closing; controls go to the new one or nowhere.
    this.#controls = undefined;
    if (session.ready.push) {
      this.#controls = session.transport;
      if (this.#away) this.#sendControl(session.transport, { type: "gateway.away", away: true });
      void this.#sendPush(session.transport);
    }

    return {
      kind: "online",
      route,
      openedAt: this.#now(),
      end,
      closed: closed.then((info) => {
        stopProjection();
        stopTerminal();
        client.close();
        if (this.#client === client) this.#client = undefined;
        if (this.#controls === session.transport) this.#controls = undefined;
        if (this.#endConnection === end) this.#endConnection = undefined;
        return info;
      }),
    };
  }
}
