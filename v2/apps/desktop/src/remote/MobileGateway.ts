import type { IncomingMessage } from "node:http";

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

export interface MobileGatewayOptions {
  store: MobileAccessStore;
  pairing: PairingWindow;
  random: RandomBytes;
  /** Where the loopback runtime listens now, with its token. The runtime can restart on a new port. */
  upstream: () => Promise<UpstreamTarget>;
  projection: () => Pick<RuntimeProjection, "projects" | "worktrees"> | undefined;
  desktopName: () => string;
  hosts: () => string[];
  /** Paired phones, live connections, or the open pairing code changed. */
  onChange: () => void;
  now?: () => number;
  log?: (message: string, detail?: Record<string, unknown>) => void;
  createUpstreamSocket?: (url: string) => WebSocket;
}

/** The first port tried, so a phone paired once finds the desktop again after a restart. */
export const DEFAULT_MOBILE_PORT = 47_321;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 30_000;
const MAX_PHONE_FRAME_BYTES = 1024 * 1024;
const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
const MAX_UNAUTHENTICATED = 16;
const MAX_CONNECTIONS_PER_DEVICE = 4;

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
  #server: WebSocketServer | undefined;
  #heartbeat: NodeJS.Timeout | undefined;
  #unauthenticated = 0;

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
    server.on("connection", (socket, request) => this.#accept(socket, request));
    server.on("error", (error) => this.#options.log?.("phone gateway error", { error: String(error) }));
    this.#heartbeat = setInterval(() => {
      for (const socket of server.clients) {
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
    if (!server) return;
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Closes a phone's live connections. Removing it from the store is the caller's job. */
  disconnect(deviceId: string): void {
    for (const close of [...(this.#byDevice.get(deviceId) ?? [])]) close(RemoteCloseCode.notPaired);
  }

  #accept(socket: WebSocket, request: IncomingMessage): void {
    const options = this.#options;
    const address = request.socket.remoteAddress ?? "unknown";
    (socket as WebSocket & { zliAlive?: boolean }).zliAlive = true;
    socket.on("pong", () => {
      (socket as WebSocket & { zliAlive?: boolean }).zliAlive = true;
    });
    if (!this.#limiter.allow(address)) {
      options.log?.("phone connection refused: too many attempts", { address });
      socket.close(RemoteCloseCode.rateLimited);
      return;
    }
    if (this.#unauthenticated >= MAX_UNAUTHENTICATED) {
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
    let counted = true;
    this.#unauthenticated += 1;
    const uncount = () => {
      if (!counted) return;
      counted = false;
      this.#unauthenticated -= 1;
    };

    const close = (code: number) => {
      if (phase === "closed") return;
      phase = "closed";
      clearTimeout(timer);
      uncount();
      this.#everyone.delete(close);
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
    const timer = setTimeout(() => close(RemoteCloseCode.handshake), HANDSHAKE_TIMEOUT_MS);

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
        options.log?.("phone handshake failed", { address, mode: parsed.mode });
        close(RemoteCloseCode.handshake);
      }
    };

    const onControl = async (message: unknown) => {
      const control = ClientControl.safeParse(message);
      if (!control.success || !hello) return close(RemoteCloseCode.protocol);
      if (hello.mode === "pair") {
        if (control.data.type !== "gateway.pair") return close(RemoteCloseCode.protocol);
        const credential = options.random(32);
        const id = toBase64Url(options.random(16));
        await options.store.addDevice({
          deviceId: id,
          name: cleanName(control.data.deviceName),
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
          options.log?.("phone credential rejected", { address });
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
        if (!control.success || control.data.type !== "gateway.unpair" || !deviceId) {
          return close(RemoteCloseCode.protocol);
        }
        const id = deviceId;
        await options.store.removeDevice(id).catch(() => undefined);
        this.disconnect(id);
        options.onChange();
        return;
      }
      if (type === "hello") {
        const parsed = ClientWireMessage.safeParse(message);
        if (!parsed.success || parsed.data.type !== "hello" || parsed.data.environmentId !== environmentId) {
          return close(RemoteCloseCode.protocol);
        }
        sendSealed(upstreamHello);
        return;
      }
      const decision = checkPhoneMessage(message, options.projection());
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

    socket.on("message", (data, isBinary) => {
      if (phase === "closed") return;
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
      maxPayload: MAX_PHONE_FRAME_BYTES,
      perMessageDeflate: false,
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
