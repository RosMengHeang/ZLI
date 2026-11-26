import { afterEach, describe, expect, it, vi } from "vitest";
import { webCryptoRandomBytes } from "./bytes.js";
import { openRemoteSession, PAIRING_APPROVAL_TIMEOUT_MS, RemoteConnectError, type WebSocketLike } from "./client.js";
import { acceptClientHello, generateKeyPair, type SecureChannel } from "./crypto.js";
import { ClientHello, RemoteCloseCode } from "./messages.js";

function fakeSocket() {
  const closes: number[] = [];
  const socket = {
    binaryType: "arraybuffer",
    send() {},
    close(code?: number) {
      closes.push(code ?? 1000);
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  } as unknown as WebSocketLike;
  return { socket, closes };
}

function options(createSocket: () => WebSocketLike, signal?: AbortSignal) {
  const key = generateKeyPair(webCryptoRandomBytes);
  return {
    url: "ws://127.0.0.1:1/remote",
    serverPublicKey: key.publicKey,
    clientStatic: key,
    target: { mode: "resume" as const, deviceId: "B".repeat(21) + "A", credential: new Uint8Array(32) },
    random: webCryptoRandomBytes,
    createSocket,
    ...(signal ? { signal } : {}),
  };
}

describe("openRemoteSession abort", () => {
  it("closes the socket and rejects with network when aborted", async () => {
    const { socket, closes } = fakeSocket();
    const controller = new AbortController();
    const pending = openRemoteSession(options(() => socket, controller.signal));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "RemoteConnectError", failure: "network" });
    expect(closes.length).toBe(1);
  });

  it("does not open a socket when already aborted", async () => {
    let created = 0;
    const controller = new AbortController();
    controller.abort();
    const pending = openRemoteSession(
      options(() => {
        created += 1;
        return fakeSocket().socket;
      }, controller.signal),
    );
    await expect(pending).rejects.toBeInstanceOf(RemoteConnectError);
    expect(created).toBe(0);
  });
});

/** A desktop on the other end of a fake socket: answers the hello, then sends what the test asks for. */
function fakeDesktop(target: "pair" | "resume") {
  const server = generateKeyPair(webCryptoRandomBytes);
  const phone = generateKeyPair(webCryptoRandomBytes);
  const pairingSecret = webCryptoRandomBytes(32);
  const closes: number[] = [];
  const received: unknown[] = [];
  let channel: SecureChannel | undefined;
  let socket: WebSocketLike | undefined;
  const createSocket = () => {
    const created = {
      binaryType: "arraybuffer",
      send(data: string | ArrayBuffer) {
        if (typeof data === "string") {
          const hello = ClientHello.parse(JSON.parse(data));
          const accepted = acceptClientHello({
            hello,
            serverStatic: server,
            psk: pairingSecret,
            random: webCryptoRandomBytes,
          });
          channel = accepted.channel;
          created.onmessage?.({ data: JSON.stringify(accepted.welcome) });
          return;
        }
        received.push(channel?.openJson(new Uint8Array(data)));
      },
      close(code?: number) {
        closes.push(code ?? 1000);
      },
      onopen: null as ((event: unknown) => void) | null,
      onmessage: null as ((event: { data: unknown }) => void) | null,
      onclose: null as ((event: { code: number }) => void) | null,
      onerror: null,
    };
    socket = created as unknown as WebSocketLike;
    queueMicrotask(() => created.onopen?.({}));
    return socket;
  };
  return {
    closes,
    received,
    options: {
      url: "ws://127.0.0.1:1/remote",
      serverPublicKey: server.publicKey,
      clientStatic: phone,
      target:
        target === "pair"
          ? { mode: "pair" as const, pairingId: `${"P".repeat(21)}A`, pairingSecret, deviceName: "Pixel 9" }
          : { mode: "resume" as const, deviceId: `${"B".repeat(21)}A`, credential: new Uint8Array(32) },
      random: webCryptoRandomBytes,
      createSocket,
    },
    send(message: unknown) {
      const sealed = channel?.sealJson(message);
      if (sealed)
        socket?.onmessage?.({ data: sealed.buffer.slice(sealed.byteOffset, sealed.byteOffset + sealed.byteLength) });
    },
    closeWith(code: number) {
      socket?.onclose?.({ code });
    },
  };
}

const ready = {
  type: "gateway.ready",
  desktopName: "Desk",
  environmentId: "00000000-0000-4000-8000-000000000001",
  hosts: ["127.0.0.1"],
  port: 47_321,
};
const paired = { type: "gateway.paired", deviceId: `${"D".repeat(21)}A`, credential: `${"C".repeat(42)}A` };

describe("openRemoteSession while the desktop asks the person to allow a pairing", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits past the usual timeout once the desktop says it is waiting, and pairs when it answers", async () => {
    vi.useFakeTimers();
    const desktop = fakeDesktop("pair");
    const onWaiting = vi.fn();
    const pending = openRemoteSession({ ...desktop.options, timeoutMs: 8_000, onWaiting });
    await vi.advanceTimersByTimeAsync(0);
    expect(desktop.received).toEqual([{ type: "gateway.pair", deviceName: "Pixel 9" }]);
    desktop.send({ type: "gateway.waiting", reason: "approval" });
    expect(onWaiting).toHaveBeenCalledTimes(1);
    // The desktop repeats it to keep the relay from closing an idle connection.
    await vi.advanceTimersByTimeAsync(20_000);
    desktop.send({ type: "gateway.waiting", reason: "approval" });
    expect(onWaiting).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(40_000);
    desktop.send(paired);
    desktop.send(ready);
    const session = await pending;
    expect(session.paired).toEqual({ deviceId: paired.deviceId, credential: paired.credential });
  });

  it("gives up after the approval timeout", async () => {
    vi.useFakeTimers();
    const desktop = fakeDesktop("pair");
    const pending = openRemoteSession({ ...desktop.options, timeoutMs: 8_000 });
    const outcome = pending.catch((error: RemoteConnectError) => error.failure);
    await vi.advanceTimersByTimeAsync(0);
    desktop.send({ type: "gateway.waiting", reason: "approval" });
    await vi.advanceTimersByTimeAsync(PAIRING_APPROVAL_TIMEOUT_MS - 1);
    expect(desktop.closes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe("timeout");
  });

  it("treats a wait on a resume as a protocol failure", async () => {
    const desktop = fakeDesktop("resume");
    const pending = openRemoteSession(desktop.options);
    await new Promise((resolve) => setTimeout(resolve, 0));
    desktop.send({ type: "gateway.waiting", reason: "approval" });
    await expect(pending).rejects.toMatchObject({ failure: "protocol" });
  });

  it("treats a wait after the pairing finished as a protocol failure", async () => {
    const desktop = fakeDesktop("pair");
    const pending = openRemoteSession(desktop.options);
    await new Promise((resolve) => setTimeout(resolve, 0));
    desktop.send(paired);
    desktop.send({ type: "gateway.waiting", reason: "approval" });
    await expect(pending).rejects.toMatchObject({ failure: "protocol" });
  });

  it("reports a refused pairing", async () => {
    const desktop = fakeDesktop("pair");
    const pending = openRemoteSession(desktop.options);
    await new Promise((resolve) => setTimeout(resolve, 0));
    desktop.closeWith(RemoteCloseCode.pairingDenied);
    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RemoteConnectError);
    expect(error).toMatchObject({
      failure: "pairing-denied",
      message: "The PC didn't allow this phone. Make a new code on the PC and try again.",
    });
  });

  it("reads a plain close while waiting as a refusal, since the relay does not pass the desktop's close code on", async () => {
    const desktop = fakeDesktop("pair");
    const pending = openRemoteSession(desktop.options);
    await new Promise((resolve) => setTimeout(resolve, 0));
    desktop.send({ type: "gateway.waiting", reason: "approval" });
    desktop.closeWith(1000);
    await expect(pending).rejects.toMatchObject({ failure: "pairing-denied" });
  });

  it("still reads a plain close before any wait as a network failure", async () => {
    const desktop = fakeDesktop("pair");
    const pending = openRemoteSession(desktop.options);
    await new Promise((resolve) => setTimeout(resolve, 0));
    desktop.closeWith(1000);
    await expect(pending).rejects.toMatchObject({ failure: "network" });
  });
});
