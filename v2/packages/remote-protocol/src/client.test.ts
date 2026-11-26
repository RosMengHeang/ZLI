import { describe, expect, it } from "vitest";
import { webCryptoRandomBytes } from "./bytes.js";
import { openRemoteSession, RemoteConnectError, type WebSocketLike } from "./client.js";
import { generateKeyPair } from "./crypto.js";

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
