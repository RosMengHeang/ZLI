import type { Duplex } from "node:stream";

import { ClientWireMessage, EnvironmentId, type RuntimeProjection } from "@zli-v2/contracts";
import {
  acceptClientHello,
  ClientControl,
  ClientHello,
  checkPhoneMessage,
  equalBytes,
  fromBase64Url,
  HandshakeError,
  hashSecret,
  isControlType,
  type RandomBytes,
  REMOTE_PATH,
  RemoteCloseCode,
  type SecureChannel,
  type ServerControl,
  toBase64Url,
} from "@zli-v2/remote-protocol";
import { type RawData, WebSocket, WebSocketServer } from "ws";

import { AttemptLimiter } from "./AttemptLimiter.js";
import type { MobileAccessStore } from "./MobileAccessStore.js";
import type { PairingWindow } from "./PairingWindow.js";

export type UpstreamTarget = { url: string; token: string; environmentId: string };

/**
 * Where a phone connection came from. A relay `client` is a key the relay derives from the phone's address; it only
 * spreads the rate limit and never says who the phone is. The handshake does that.
 */
export type ConnectionOrigin = { route: "lan"; address: string } | { route: "relay"; client: string };

/** A pairing waiting on the person at the desktop. `signal` aborts when the phone leaves or the wait runs out. */
export type PairingApprovalRequest = { deviceName: string; route: "lan" | "relay"; signal: AbortSignal };

export interface MobileGatewayOptions {
  store: MobileAccessStore;
  pairing: PairingWindow;
  random: RandomBytes;
  /** Where the loopback runtime listens now, with its token. The runtime can restart on a new port. */
  upstream: () => Promise<UpstreamTarget>;
  /** The phone policy checks commands against these: projects, worktrees, and the files each review lists. */
  projection: () => Pick<RuntimeProjection, "projects" | "worktrees" | "reviews"> | undefined;
  desktopName: () => string;
  hosts: () => string[];
  /** Paired phones, live connections, or the open pairing code changed. */
  onChange: () => void;
  /**
   * Asks the person at the desktop to allow a pairing that came through the relay, where a leaked code could reach the
   * desktop from anywhere. Without it, relay pairings are refused.
   */
  approvePairing?: (request: PairingApprovalRequest) => Promise<boolean>;
  now?: () => number;
  log?: (message: string, detail?: Record<string, unknown>) => void;
  createUpstreamSocket?: (url: string) => WebSocket;
}

/** The first port tried, so a phone paired once finds the desktop again after a restart. */
export const DEFAULT_MOBILE_PORT = 47_321;
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** How long a relay pairing waits for the person to allow it. Shorter than the phone's wait, so the refusal reaches it. */
export const PAIRING_APPROVAL_WAIT_MS = 120_000;
/** The relay closes a connection that is quiet for a minute, so a pairing that waits says so again before that. */
const APPROVAL_REPEAT_MS = 20_000;
const HEARTBEAT_MS = 30_000;
/** Room for a message with a few photos; the phone shrinks each one before it sends. */
const MAX_PHONE_FRAME_BYTES = 8 * 1024 * 1024;
/** Handshake and pairing messages are small, so only a paired, open connection gets the large frame limit. */
const MAX_HANDSHAKE_FRAME_BYTES = 64 * 1024;
/** Frame settings for every phone socket: the LAN server listens with them, and relay sockets must be dialed with them. */
export const PHONE_SOCKET_OPTIONS = { maxPayload: MAX_PHONE_FRAME_BYTES, perMessageDeflate: false } as const;
const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
const MAX_UNAUTHENTICATED = 16;
/** Relay connections share this smaller part of MAX_UNAUTHENTICATED, so strangers online cannot crowd out the LAN. */
const MAX_UNAUTHENTICATED_RELAY = 4;
const MAX_CONNECTIONS_PER_DEVICE = 4;
const RELAY_CLIENT_KEY = /^[A-Za-z0-9_-]{1,64}$/u;
/**
 * All the bytes a connection may send before it is paired and open. The frame limit is checked only once a whole frame
 * has arrived, and the server takes frames up to MAX_PHONE_FRAME_BYTES, so without this anyone on the network could make
 * the desktop hold 8 MB for each of its unpaired connections.
 */
const MAX_HANDSHAKE_BYTES = 4 * MAX_HANDSHAKE_FRAME_BYTES;

type Phase = "hello" | "handshake" | "control" | "upstream" | "open" | "closed";

/**
 * The LAN endpoint phones connect to. It never exposes the runtime itself: each phone gets its own
 * loopback connection to the runtime, opened by the gateway with the runtime token after the phone
 * proves it is paired, and every message the phone sends passes the phone allowlist first.
 */
export class MobileGateway {
  readonly #options: MobileGatewayOptions;
  readonly #limiter: AttemptLimiter;
  readonly #byDevice = new Map<string, Set<(code: number) => void>>();
  readonly #everyone = new Set<(code: number) => void>();
  /** Connections whose app said it left the screen. They stay open but show no alerts. */
  readonly #away = new Set<(code: number) => void>();
  /** Sockets the desktop dialed out to the relay. The server does not list them, so the heartbeat and stop use this. */
  readonly #relaySockets = new Set<WebSocket>();
  #server: WebSocketServer | undefined;
  #heartbeat: NodeJS.Timeout | undefined;
  #unauthenticated = 0;
  #unauthenticatedRelay = 0;

  constructor(options: MobileGatewayOptions) {
    this.#options = options;
    this.#limiter = new AttemptLimiter(20, 60_000, options.now);
  }

  get listening(): boolean {
    return this.#server !== undefined;
  }

  connectedDeviceIds(): Set<string> {
    return new Set([...this.#byDevice].filter(([, closers]) => closers.size > 0).map(([deviceId]) => deviceId));
  }

  /** Phones with a connection whose app is on screen or kept running, which show their own alerts. */
  attentiveDeviceIds(): Set<string> {
    return new Set(
      [...this.#byDevice]
        .filter(([, closers]) => [...closers].some((close) => !this.#away.has(close)))
        .map(([deviceId]) => deviceId),
    );
  }

  /** Listens on every interface. Falls back to a free port when the preferred one is taken. */
  async start(options: { port: number; host?: string }): Promise<number> {
    if (this.#server) throw new Error("Phone access is already listening.");
    const host = options.host ?? "0.0.0.0";
    let server: WebSocketServer;
    try {
      server = await listen(host, options.port);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || options.port === 0) throw error;
      server = await listen(host, 0);
    }
    this.#server = server;
    server.on("connection", (socket, request) =>
      this.#accept(socket, { route: "lan", address: request.socket.remoteAddress ?? "unknown" }, request.socket),
    );
    server.on("error", (error) => this.#options.log?.("phone gateway error", { error: String(error) }));
    this.#heartbeat = setInterval(() => {
      for (const socket of [...server.clients, ...this.#relaySockets]) {
        const tracked = socket as WebSocket & { zliAlive?: boolean };
        if (tracked.zliAlive === false) {
          socket.terminate();
          continue;
        }
        tracked.zliAlive = false;
        socket.ping();
      }
    }, HEARTBEAT_MS);
    this.#heartbeat.unref?.();
    const address = server.address();
    return typeof address === "object" && address ? address.port : options.port;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    for (const close of [...this.#everyone]) close(1001);
    for (const socket of [...this.#relaySockets]) socket.terminate();
    this.#relaySockets.clear();
    if (server) {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // Closing a phone's connection records when it was last seen; quitting must not cut that write short.
    await this.#options.store.settled();
  }

  /** Closes a phone's live connections. Removing it from the store is the caller's job. */
  disconnect(deviceId: string): void {
    for (const close of [...(this.#byDevice.get(deviceId) ?? [])]) close(RemoteCloseCode.notPaired);
  }

  /**
   * Takes a phone connection that did not come through the LAN server, such as one the relay handed over. Create the
   * socket with PHONE_SOCKET_OPTIONS: the gateway can only check a frame once it has arrived whole, so the frame cap has
   * to be set on the socket itself.
   */
  accept(socket: WebSocket, origin: ConnectionOrigin): void {
    // The gateway owns the socket from here. A refused one can still fail late, and an unheard error would throw.
    socket.on("error", () => undefined);
    // A heartbeat ping on a socket that is still connecting would throw.
    if (socket.readyState !== WebSocket.OPEN) {
      socket.terminate();
      return;
    }
    if (!this.#server) {
      socket.close(RemoteCloseCode.tryAgain);
      return;
    }
    // A compressed frame can inflate far past what the frame cap saw on the wire.
    if (socket.extensions.includes("permessage-deflate")) {
      socket.close(RemoteCloseCode.protocol);
      // The peer may never answer the close, and a refused socket should not linger.
      socket.terminate();
      return;
    }
    this.#accept(socket, origin);
  }

  /**
   * `raw` is the network socket under a LAN connection, counted as bytes arrive. A relay socket has none the gateway
   * owns, so its frames are checked whole on arrival instead.
   */
  #accept(socket: WebSocket, origin: ConnectionOrigin, raw?: Duplex): void {
    const options = this.#options;
    const relay = origin.route === "relay";
    const limitKey = relay
      ? `relay:${RELAY_CLIENT_KEY.test(origin.client) ? origin.client : "invalid"}`
      : origin.address;
    // Kept for the life of the connection, so the phone policy can tell a relayed phone from one on the LAN.
    const route = origin.route;
    const peer = relay ? { route, client: limitKey } : { route, address: origin.address };
    (socket as WebSocket & { zliAlive?: boolean }).zliAlive = true;
    socket.on("pong", () => {
      (socket as WebSocket & { zliAlive?: boolean }).zliAlive = true;
    });
    if (relay) {
      // Tracked until the socket is gone, refused or not, so stop() can cut it off instead of waiting on the close.
      this.#relaySockets.add(socket);
      socket.once("close", () => this.#relaySockets.delete(socket));
    }
    if (!this.#limiter.allow(limitKey)) {
      options.log?.("phone connection refused: too many attempts", peer);
      socket.close(RemoteCloseCode.rateLimited);
      return;
    }
    if (
      this.#unauthenticated >= MAX_UNAUTHENTICATED ||
      (relay && this.#unauthenticatedRelay >= MAX_UNAUTHENTICATED_RELAY)
    ) {
      socket.close(RemoteCloseCode.tryAgain);
      return;
    }

    let phase: Phase = "hello";
    let channel: SecureChannel | undefined;
    let hello: ClientHello | undefined;
    let deviceId: string | undefined;
    let upstream: WebSocket | undefined;
    let upstreamHello: unknown;
    let environmentId: string | undefined;
    let approval: AbortController | undefined;
    let approvalRepeat: NodeJS.Timeout | undefined;
    let counted = true;
    this.#unauthenticated += 1;
    if (relay) this.#unauthenticatedRelay += 1;
    const uncount = () => {
      if (!counted) return;
      counted = false;
      this.#unauthenticated -= 1;
      if (relay) this.#unauthenticatedRelay -= 1;
    };

    const close = (code: number) => {
      if (phase === "closed") return;
      phase = "closed";
      clearTimeout(timer);
      clearInterval(approvalRepeat);
      approval?.abort();
      uncount();
      this.#relaySockets.delete(socket);
      this.#everyone.delete(close);
      this.#away.delete(close);
      if (deviceId) {
        const closers = this.#byDevice.get(deviceId);
        closers?.delete(close);
        if (closers?.size === 0) this.#byDevice.delete(deviceId);
        void options.store
          .touchDevice(deviceId, new Date(options.now?.() ?? Date.now()).toISOString())
          .catch(() => undefined)
          .finally(options.onChange);
      }
      upstream?.close();
      upstream = undefined;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(code);
    };
    this.#everyone.add(close);
    let timer = setTimeout(() => close(RemoteCloseCode.handshake), HANDSHAKE_TIMEOUT_MS);

    const sendSealed = (message: unknown) => {
      if (!channel || socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        // A phone that stopped reading would otherwise hold the whole event stream in memory.
        close(RemoteCloseCode.tryAgain);
        return;
      }
      socket.send(channel.sealJson(message));
    };

    const onHello = async (data: RawData, isBinary: boolean) => {
      if (isBinary) return close(RemoteCloseCode.protocol);
      let parsed: ClientHello;
      try {
        parsed = ClientHello.parse(JSON.parse(rawText(data)));
      } catch {
        return close(RemoteCloseCode.protocol);
      }
      let psk: Uint8Array | undefined;
      if (parsed.mode === "pair") {
        psk = options.pairing.secretFor(parsed.pairingId);
        if (!psk) return close(RemoteCloseCode.pairingCode);
      } else {
        const device = options.store.device(parsed.deviceId);
        if (!device || device.publicKey !== parsed.clientStatic) return close(RemoteCloseCode.notPaired);
      }
      try {
        const accepted = acceptClientHello({
          hello: parsed,
          serverStatic: await options.store.keyPair(),
          psk,
          random: options.random,
        });
        if (phase !== "handshake") return;
        if (parsed.mode === "pair" && !options.pairing.consume(parsed.pairingId)) {
          return close(RemoteCloseCode.pairingCode);
        }
        if (parsed.mode === "pair") options.onChange();
        channel = accepted.channel;
        hello = parsed;
        phase = "control";
        socket.send(JSON.stringify(accepted.welcome));
      } catch (error) {
        if (!(error instanceof HandshakeError)) throw error;
        if (parsed.mode === "pair") options.pairing.recordFailure(parsed.pairingId);
        options.log?.("phone handshake failed", { ...peer, mode: parsed.mode });
        close(RemoteCloseCode.handshake);
      }
    };

    /**
     * Holds a pairing until the person allows it. The connection stays unpaired meanwhile: it keeps its place in the
     * unpaired count and the small frame limit, and anything the phone sends closes it.
     */
    const approve = async (deviceName: string): Promise<boolean> => {
      const ask = options.approvePairing;
      if (!ask) return false;
      const controller = new AbortController();
      approval = controller;
      // The approval wait replaces the handshake deadline.
      clearTimeout(timer);
      timer = setTimeout(() => close(RemoteCloseCode.pairingDenied), PAIRING_APPROVAL_WAIT_MS);
      const waiting: ServerControl = { type: "gateway.waiting", reason: "approval" };
      sendSealed(waiting);
      approvalRepeat = setInterval(() => sendSealed(waiting), APPROVAL_REPEAT_MS);
      const cancelled = new Promise<false>((resolve) =>
        controller.signal.addEventListener("abort", () => resolve(false), { once: true }),
      );
      try {
        const allowed = await Promise.race([ask({ deviceName, route, signal: controller.signal }), cancelled]);
        return allowed === true && !controller.signal.aborted;
      } catch {
        return false;
      } finally {
        clearInterval(approvalRepeat);
        approval = undefined;
      }
    };

    const onControl = async (message: unknown) => {
      const control = ClientControl.safeParse(message);
      if (!control.success || !hello) return close(RemoteCloseCode.protocol);
      if (hello.mode === "pair") {
        if (control.data.type !== "gateway.pair") return close(RemoteCloseCode.protocol);
        const name = cleanName(control.data.deviceName);
        if (relay && !(await approve(name))) return close(RemoteCloseCode.pairingDenied);
        if (phase === "closed") return;
        const credential = options.random(32);
        const id = toBase64Url(options.random(16));
        await options.store.addDevice({
          deviceId: id,
          name,
          publicKey: hello.clientStatic,
          credentialHash: toBase64Url(hashSecret(credential)),
          pairedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
        });
        deviceId = id;
        sendSealed({ type: "gateway.paired", deviceId: id, credential: toBase64Url(credential) });
      } else {
        if (control.data.type !== "gateway.auth") return close(RemoteCloseCode.protocol);
        const device = options.store.device(hello.deviceId);
        const presented = hashSecret(fromBase64Url(control.data.credential));
        if (!device || !equalBytes(presented, fromBase64Url(device.credentialHash))) {
          options.log?.("phone credential rejected", peer);
          return close(RemoteCloseCode.notPaired);
        }
        deviceId = device.deviceId;
      }
      if (phase === "closed") return;
      const closers = this.#byDevice.get(deviceId) ?? new Set();
      if (closers.size >= MAX_CONNECTIONS_PER_DEVICE) [...closers][0]?.(RemoteCloseCode.tryAgain);
      closers.add(close);
      this.#byDevice.set(deviceId, closers);
      uncount();
      clearTimeout(timer);
      phase = "upstream";
      void options.store
        .touchDevice(deviceId, new Date(options.now?.() ?? Date.now()).toISOString())
        .catch(() => undefined);
      options.onChange();
      connectUpstream();
    };

    const connectUpstream = () => {
      void options
        .upstream()
        .then((target) => {
          if (phase !== "upstream") return;
          environmentId = target.environmentId;
          const connection = (options.createUpstreamSocket ?? ((url) => new WebSocket(url)))(target.url);
          upstream = connection;
          connection.on("open", () =>
            connection.send(
              JSON.stringify({
                type: "hello",
                protocolVersion: 1,
                token: target.token,
                environmentId: target.environmentId,
              }),
            ),
          );
          connection.on("message", (data) => {
            if (upstream !== connection) return;
            let message: unknown;
            try {
              message = JSON.parse(rawText(data));
            } catch {
              return;
            }
            if (phase === "upstream") {
              if ((message as { type?: unknown } | null)?.type !== "hello") return close(RemoteCloseCode.tryAgain);
              upstreamHello = message;
              phase = "open";
              const ready: ServerControl = {
                type: "gateway.ready",
                desktopName: options.desktopName().slice(0, 80) || "ZLI desktop",
                environmentId: EnvironmentId.parse(target.environmentId),
                hosts: options.hosts(),
                port: this.#port(),
                push: true,
              };
              sendSealed(ready);
              return;
            }
            sendSealed(message);
          });
          connection.on("close", () => {
            if (upstream === connection) close(RemoteCloseCode.tryAgain);
          });
          connection.on("error", () => {
            if (upstream === connection) close(RemoteCloseCode.tryAgain);
          });
        })
        .catch(() => close(RemoteCloseCode.tryAgain));
    };

    const onWire = async (message: unknown) => {
      const type = (message as { type?: unknown } | null)?.type;
      if (isControlType(type)) {
        const control = ClientControl.safeParse(message);
        if (!control.success || !deviceId) return close(RemoteCloseCode.protocol);
        const id = deviceId;
        switch (control.data.type) {
          case "gateway.unpair":
            await options.store.removeDevice(id).catch(() => undefined);
            this.disconnect(id);
            options.onChange();
            return;
          case "gateway.push": {
            const { token, platform } = control.data;
            const changed = await options.store.setPush(id, token ? { token, platform } : undefined).catch(() => false);
            if (changed) options.onChange();
            return;
          }
          case "gateway.away":
            if (control.data.away) this.#away.add(close);
            else this.#away.delete(close);
            return;
          default:
            return close(RemoteCloseCode.protocol);
        }
      }
      if (type === "hello") {
        const parsed = ClientWireMessage.safeParse(message);
        if (!parsed.success || parsed.data.type !== "hello" || parsed.data.environmentId !== environmentId) {
          return close(RemoteCloseCode.protocol);
        }
        sendSealed(upstreamHello);
        return;
      }
      // Read on every message, so changing the setting applies to sessions already open.
      const decision = checkPhoneMessage(message, options.projection(), {
        route,
        remoteTerminalInput: options.store.relay.remoteTerminalInput,
      });
      if (decision.kind === "invalid") return close(RemoteCloseCode.protocol);
      if (decision.kind === "reject") {
        options.log?.("phone command refused", { deviceId, reason: decision.reason });
        sendSealed({
          type: "response",
          response: {
            commandId: decision.commandId,
            accepted: false,
            error: { code: "unauthorized", message: decision.reason, retryable: false },
          },
        });
        return;
      }
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(decision.message));
    };

    let handshakeBytes = 0;
    const tooMuchBeforePairing = () => {
      options.log?.("phone connection refused: too much data before pairing", peer);
      close(RemoteCloseCode.protocol);
      socket.terminate();
    };
    socket.on("message", (data, isBinary) => {
      if (phase === "closed") return;
      const bytes = frameBytes(data);
      // The LAN server enforces this as maxPayload; a socket the desktop dialed has no server, so it is checked here.
      if (bytes > MAX_PHONE_FRAME_BYTES) return close(RemoteCloseCode.protocol);
      if (phase !== "open" && bytes > MAX_HANDSHAKE_FRAME_BYTES) return close(RemoteCloseCode.protocol);
      if (!raw && phase !== "open") {
        handshakeBytes += bytes;
        if (handshakeBytes > MAX_HANDSHAKE_BYTES) return tooMuchBeforePairing();
      }
      if (phase === "hello") {
        phase = "handshake";
        void onHello(data, isBinary).catch(() => close(RemoteCloseCode.handshake));
        return;
      }
      if (phase === "handshake" || !isBinary || !channel) return close(RemoteCloseCode.protocol);
      let message: unknown;
      try {
        message = channel.openJson(rawBytes(data));
      } catch {
        return close(RemoteCloseCode.protocol);
      }
      if (phase === "control") {
        phase = "upstream";
        void onControl(message).catch(() => close(RemoteCloseCode.protocol));
        return;
      }
      if (phase !== "open") return close(RemoteCloseCode.protocol);
      void onWire(message).catch(() => close(RemoteCloseCode.protocol));
    });
    // Counted on the network socket, as bytes arrive, so a large frame from an unpaired connection is cut off early.
    if (raw) {
      const countHandshake = (chunk: Buffer) => {
        if (phase === "open" || phase === "closed") {
          raw.off("data", countHandshake);
          return;
        }
        handshakeBytes += chunk.length;
        if (handshakeBytes > MAX_HANDSHAKE_BYTES) {
          raw.off("data", countHandshake);
          tooMuchBeforePairing();
        }
      };
      raw.on("data", countHandshake);
    }
    socket.on("close", () => close(1000));
    socket.on("error", () => close(RemoteCloseCode.protocol));
  }

  #port(): number {
    const address = this.#server?.address();
    return typeof address === "object" && address ? address.port : 0;
  }
}

function listen(host: string, port: number): Promise<WebSocketServer> {
  return new Promise((resolve, reject) => {
    const server = new WebSocketServer({
      host,
      port,
      path: REMOTE_PATH,
      ...PHONE_SOCKET_OPTIONS,
      clientTracking: true,
    });
    server.once("listening", () => {
      server.off("error", reject);
      resolve(server);
    });
    server.once("error", reject);
  });
}

function rawBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function frameBytes(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  return data.byteLength;
}

function rawText(data: RawData): string {
  return Buffer.from(rawBytes(data)).toString("utf8");
}

/** Phone names show in Settings, so control characters and extra spaces are dropped. */
function cleanName(name: string): string {
  const cleaned = name
    .replace(/\p{Cc}/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 60);
  return cleaned || "Phone";
}
