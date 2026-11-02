import { fromBase64Url, type RandomBytes, toBase64Url } from "./bytes.js";
import { type KeyPair, type SecureChannel, startClientHandshake } from "./crypto.js";
import {
  type ClientControl,
  isControlType,
  REMOTE_PATH,
  RemoteCloseCode,
  ServerControl,
  ServerWelcome,
} from "./messages.js";

/** The part of the WebSocket API that browsers, Node 22+, and React Native all provide. */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type CreateWebSocket = (url: string) => WebSocketLike;

export type RemoteConnectTarget =
  | { mode: "pair"; pairingId: string; pairingSecret: Uint8Array; deviceName: string }
  | { mode: "resume"; deviceId: string; credential: Uint8Array };

export type RemoteReady = Extract<ServerControl, { type: "gateway.ready" }>;

export type RemoteFailure =
  | "network"
  | "timeout"
  | "protocol"
  | "handshake"
  | "not-paired"
  | "pairing-code"
  | "rate-limited"
  | "unavailable";

export class RemoteConnectError extends Error {
  override name = "RemoteConnectError";
  constructor(
    readonly failure: RemoteFailure,
    message: string,
  ) {
    super(message);
  }
}

export function failureForCloseCode(code: number): RemoteFailure {
  switch (code) {
    case RemoteCloseCode.protocol:
      return "protocol";
    case RemoteCloseCode.handshake:
      return "handshake";
    case RemoteCloseCode.notPaired:
      return "not-paired";
    case RemoteCloseCode.pairingCode:
      return "pairing-code";
    case RemoteCloseCode.rateLimited:
      return "rate-limited";
    case RemoteCloseCode.tryAgain:
      return "unavailable";
    default:
      return "network";
  }
}

const failureMessages: Record<RemoteFailure, string> = {
  network: "Could not reach the desktop. Check that the phone is on the same network.",
  timeout: "The desktop did not answer in time.",
  protocol: "The connection was interrupted by a message that could not be read.",
  handshake: "The desktop could not confirm who it is. Pair again from the desktop.",
  "not-paired": "This desktop no longer recognizes this phone. Pair again.",
  "pairing-code": "That pairing code expired or was already used. Make a new one on the desktop.",
  "rate-limited": "Too many attempts. Wait a minute and try again.",
  unavailable: "ZLI on the desktop is still starting. Try again in a moment.",
};

export function failureMessage(failure: RemoteFailure): string {
  return failureMessages[failure];
}

export type RemoteCloseInfo = { failure: RemoteFailure; code: number };

/** A runtime transport over the encrypted channel. It matches `RuntimeTransport` from client-runtime. */
export interface RemoteTransport {
  send(message: unknown): void;
  close(): void;
  onMessage(listener: (message: unknown) => void): () => void;
  onClose(listener: (info: RemoteCloseInfo) => void): () => void;
}

export type RemoteSession = {
  transport: RemoteTransport;
  ready: RemoteReady;
  /** Set after a pairing: what the phone stores to reconnect later. */
  paired?: { deviceId: string; credential: string };
};

export function remoteUrl(host: string, port: number): string {
  return `ws://${host}:${port}${REMOTE_PATH}`;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function frameBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return undefined;
}

/**
 * Opens an encrypted session to a desktop gateway: the handshake, then pairing or the device
 * credential, then the gateway's ready message. Rejects with RemoteConnectError.
 */
export function openRemoteSession(options: {
  url: string;
  serverPublicKey: Uint8Array;
  clientStatic: KeyPair;
  target: RemoteConnectTarget;
  random: RandomBytes;
  createSocket: CreateWebSocket;
  timeoutMs?: number;
}): Promise<RemoteSession> {
  const { target } = options;
  return new Promise((resolve, reject) => {
    let socket: WebSocketLike;
    try {
      socket = options.createSocket(options.url);
    } catch {
      reject(new RemoteConnectError("network", failureMessage("network")));
      return;
    }
    socket.binaryType = "arraybuffer";
    const handshake = startClientHandshake({
      serverPublicKey: options.serverPublicKey,
      clientStatic: options.clientStatic,
      target:
        target.mode === "pair"
          ? { mode: "pair", pairingId: target.pairingId, pairingSecret: target.pairingSecret }
          : { mode: "resume", deviceId: target.deviceId },
      random: options.random,
    });
    let channel: SecureChannel | undefined;
    let paired: RemoteSession["paired"];
    let settled = false;
    let closed = false;
    const messageListeners = new Set<(message: unknown) => void>();
    const closeListeners = new Set<(info: RemoteCloseInfo) => void>();

    const fail = (failure: RemoteFailure, code: number = RemoteCloseCode.protocol) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new RemoteConnectError(failure, failureMessage(failure)));
      }
      if (!closed) {
        closed = true;
        try {
          socket.close(code);
        } catch {
          // Already closing.
        }
      }
    };
    const timer = setTimeout(() => fail("timeout", 1000), options.timeoutMs ?? 10_000);

    const sendControl = (message: ClientControl) => {
      if (channel) socket.send(toArrayBuffer(channel.sealJson(message)));
    };

    const transport: RemoteTransport = {
      send(message) {
        if (closed || !channel) return;
        socket.send(toArrayBuffer(channel.sealJson(message)));
      },
      close() {
        if (closed) return;
        closed = true;
        socket.close(1000);
      },
      onMessage(listener) {
        messageListeners.add(listener);
        return () => messageListeners.delete(listener);
      },
      onClose(listener) {
        closeListeners.add(listener);
        return () => closeListeners.delete(listener);
      },
    };

    socket.onopen = () => socket.send(JSON.stringify(handshake.hello));
    socket.onerror = () => {
      if (!settled) fail("network", 1000);
    };
    socket.onclose = (event) => {
      const failure = failureForCloseCode(event.code);
      closed = true;
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new RemoteConnectError(failure, failureMessage(failure)));
        return;
      }
      for (const listener of closeListeners) listener({ failure, code: event.code });
    };
    socket.onmessage = (event) => {
      if (closed) return;
      if (!channel) {
        if (typeof event.data !== "string") return fail("protocol");
        let welcome: ServerWelcome;
        try {
          welcome = ServerWelcome.parse(JSON.parse(event.data));
          channel = handshake.finish(welcome);
        } catch {
          return fail("handshake", RemoteCloseCode.handshake);
        }
        if (target.mode === "pair") sendControl({ type: "gateway.pair", deviceName: target.deviceName });
        else sendControl({ type: "gateway.auth", credential: toBase64Url(target.credential) });
        return;
      }
      const bytes = frameBytes(event.data);
      if (!bytes) return fail("protocol");
      let message: unknown;
      try {
        message = channel.openJson(bytes);
      } catch {
        return fail("protocol");
      }
      const type = (message as { type?: unknown } | null)?.type;
      if (isControlType(type)) {
        const control = ServerControl.safeParse(message);
        if (!control.success) return fail("protocol");
        if (control.data.type === "gateway.paired") {
          if (target.mode !== "pair" || paired) return fail("protocol");
          paired = { deviceId: control.data.deviceId, credential: control.data.credential };
          return;
        }
        if (settled) return fail("protocol");
        if (target.mode === "pair" && !paired) return fail("protocol");
        settled = true;
        clearTimeout(timer);
        resolve({ transport, ready: control.data, ...(paired ? { paired } : {}) });
        return;
      }
      if (!settled) return fail("protocol");
      for (const listener of messageListeners) listener(message);
    };
  });
}

/** Asks the desktop to forget this phone. Resolves once the request is sent or the attempt fails. */
export async function requestUnpair(options: Parameters<typeof openRemoteSession>[0]): Promise<void> {
  const session = await openRemoteSession(options);
  session.transport.send({ type: "gateway.unpair" });
  // Give the frame a moment to leave before the socket closes.
  await new Promise((resolve) => setTimeout(resolve, 200));
  session.transport.close();
}

export function credentialBytes(credential: string): Uint8Array {
  return fromBase64Url(credential);
}
