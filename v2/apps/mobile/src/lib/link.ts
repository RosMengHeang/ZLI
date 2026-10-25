import { RuntimeClient, type TerminalClientMessage } from "@zli-v2/client-runtime";
import type { RpcResponse, RuntimeProjection } from "@zli-v2/contracts";
import {
  type CreateWebSocket,
  credentialBytes,
  failureMessage,
  fromBase64Url,
  keyPairFromSecret,
  openRemoteSession,
  type RandomBytes,
  RemoteConnectError,
  type RemoteCloseInfo,
  type RemoteFailure,
  type RemoteSession,
  remoteUrl,
} from "@zli-v2/remote-protocol";

import { hostsToTry, samePairing, type StoredPairing, withReady } from "./pairingRecord.js";

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

export type LinkState =
  | { kind: "connecting"; attempt: number }
  | { kind: "online"; host: string }
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
};

export type LinkOptions = {
  pairing: StoredPairing;
  random: RandomBytes;
  createSocket: CreateWebSocket;
  newId: () => string;
  onPairingChange?: (pairing: StoredPairing) => void;
  now?: () => number;
  openSession?: typeof openRemoteSession;
};

type Attempt =
  | { kind: "online"; closed: Promise<RemoteCloseInfo | undefined>; openedAt: number }
  | { kind: "failed"; failure: RemoteFailure }
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
  #endConnection: (() => void) | undefined;
  #wake: (() => void) | undefined;
  #running = false;
  #loop: Promise<void> | undefined;

  constructor(options: LinkOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#snapshot = { state: { kind: "paused" }, projection: undefined, generation: 0, pairing: options.pairing };
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
      if (result.kind === "online") {
        const info = await result.closed;
        if (!this.#running) break;
        if (info && blockingFailures.has(info.failure)) {
          this.#block(failureMessage(info.failure));
          break;
        }
        const stable = this.#now() - result.openedAt >= STABLE_CONNECTION_MS;
        attempt = stable ? 0 : attempt + 1;
        if (stable) continue;
        failure = info?.failure ?? "network";
      } else {
        attempt += 1;
        failure = result.failure;
      }
      const delay =
        failure === "rate-limited"
          ? RATE_LIMIT_DELAY_MS
          : (RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length) - 1] ?? 1_000);
      this.#update({
        state: { kind: "offline", failure, message: failureMessage(failure), retryAt: this.#now() + delay },
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
    const open = this.#options.openSession ?? openRemoteSession;
    let lastFailure: RemoteFailure = "network";
    for (const host of hostsToTry(pairing)) {
      if (!this.#running) return { kind: "stopped" };
      let session: RemoteSession;
      try {
        session = await open({
          url: remoteUrl(host, pairing.port),
          serverPublicKey: fromBase64Url(pairing.desktopKey),
          clientStatic: keyPairFromSecret(fromBase64Url(pairing.phoneSecret)),
          target: { mode: "resume", deviceId: pairing.deviceId, credential: credentialBytes(pairing.credential) },
          random: this.#options.random,
          createSocket: this.#options.createSocket,
          timeoutMs: 8_000,
        });
      } catch (error) {
        if (!(error instanceof RemoteConnectError)) throw error;
        if (blockingFailures.has(error.failure)) return { kind: "blocked", message: error.message };
        if (error.failure === "rate-limited") return { kind: "failed", failure: "rate-limited" };
        lastFailure = error.failure;
        continue;
      }
      if (!this.#running) {
        session.transport.close();
        return { kind: "stopped" };
      }
      const online = await this.#adopt(session, host);
      if (online) return online;
      lastFailure = "protocol";
    }
    return { kind: "failed", failure: lastFailure };
  }

  /** Runs the runtime handshake over a fresh session and makes it the current connection. */
  async #adopt(session: RemoteSession, host: string): Promise<Attempt | undefined> {
    let resolveClosed!: (info: RemoteCloseInfo | undefined) => void;
    const closed = new Promise<RemoteCloseInfo | undefined>((resolve) => {
      resolveClosed = resolve;
    });
    session.transport.onClose((info) => resolveClosed(info));
    this.#endConnection = () => {
      resolveClosed(undefined);
      session.transport.close();
    };

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
      this.#endConnection = undefined;
      return undefined;
    } finally {
      clearTimeout(timer);
    }

    this.#client = client;
    const current = client.projection();
    if (current) this.#update({ projection: current });
    const stopProjection = client.subscribe((projection) => this.#update({ projection }));
    const stopTerminal = client.subscribeTerminal((message) => {
      for (const listener of this.#terminalListeners) listener(message);
    });
    const pairing = withReady(this.#snapshot.pairing, session.ready, host);
    const pairingChanged = !samePairing(pairing, this.#snapshot.pairing);
    this.#update({ state: { kind: "online", host }, generation: this.#snapshot.generation + 1, pairing });
    if (pairingChanged) this.#options.onPairingChange?.(pairing);

    return {
      kind: "online",
      openedAt: this.#now(),
      closed: closed.then((info) => {
        stopProjection();
        stopTerminal();
        client.close();
        if (this.#client === client) this.#client = undefined;
        this.#endConnection = undefined;
        return info;
      }),
    };
  }
}
