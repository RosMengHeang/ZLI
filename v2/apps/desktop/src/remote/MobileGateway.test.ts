import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type CreateWebSocket,
  fromBase64Url,
  generateKeyPair,
  openRemoteSession,
  type RemoteConnectError,
  type RemoteSession,
  webCryptoRandomBytes as random,
  remoteUrl,
  toBase64Url,
  type WebSocketLike,
} from "@zli-v2/remote-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { MobileAccessStore, type SecretCodec } from "./MobileAccessStore.js";
import { MobileGateway } from "./MobileGateway.js";
import { PairingWindow } from "./PairingWindow.js";

const environmentId = "00000000-0000-4000-8000-000000000001";
const projectId = "40000000-0000-4000-8000-000000000001";
const worktreeId = "50000000-0000-4000-8000-000000000001";
const threadId = "60000000-0000-4000-8000-000000000001";
const commandId = "10000000-0000-4000-8000-000000000001";

const plainCodec: SecretCodec = {
  seal: (secret) => toBase64Url(secret),
  open: (sealed) => fromBase64Url(sealed),
};

const createSocket: CreateWebSocket = (url) => new WebSocket(url) as unknown as WebSocketLike;

/** A stand-in for the loopback runtime: answers hello, accepts commands, and records what arrives. */
async function fakeRuntime() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const received: unknown[] = [];
  const tokens: string[] = [];
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { type: string; token?: string; request?: { commandId: string } };
      received.push(message);
      if (message.type === "hello") {
        tokens.push(message.token ?? "");
        socket.send(
          JSON.stringify({
            type: "hello",
            protocolVersion: 1,
            environment: { environmentId, label: "Local", protocolVersion: 1, capabilities: {} },
          }),
        );
      } else if (message.type === "command" && message.request) {
        socket.send(
          JSON.stringify({ type: "response", response: { commandId: message.request.commandId, accepted: true } }),
        );
      }
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `ws://127.0.0.1:${port}/rpc`,
    received,
    tokens,
    dropAll: () => {
      for (const client of server.clients) client.terminate();
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function nextMessage(session: RemoteSession, predicate: (message: { type?: string }) => boolean = () => true) {
  return new Promise<{ type?: string; [key: string]: unknown }>((resolve) => {
    const off = session.transport.onMessage((message) => {
      const typed = message as { type?: string };
      if (!predicate(typed)) return;
      off();
      resolve(typed);
    });
  });
}

function closed(session: RemoteSession) {
  return new Promise<number>((resolve) => session.transport.onClose(({ code }) => resolve(code)));
}

describe("MobileGateway", () => {
  let directory: string;
  let runtime: Awaited<ReturnType<typeof fakeRuntime>>;
  let store: MobileAccessStore;
  let pairing: PairingWindow;
  let gateway: MobileGateway;
  let port: number;
  let changes = 0;
  let now = Date.now();

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "zli-mobile-"));
    runtime = await fakeRuntime();
    store = new MobileAccessStore(join(directory, "mobile.json"), plainCodec, random);
    await store.load();
    now = Date.now();
    pairing = new PairingWindow(random, () => now);
    changes = 0;
    gateway = new MobileGateway({
      store,
      pairing,
      random,
      upstream: async () => ({ url: runtime.url, token: "runtime-token", environmentId }),
      projection: () => ({
        projects: [{ projectId: projectId as never, path: "/work/app", name: "app" }],
        worktrees: [
          {
            worktreeId: worktreeId as never,
            projectId: projectId as never,
            path: "/work/app-worktrees/fix",
            branch: "fix",
            status: "ready",
          },
        ],
      }),
      desktopName: () => "Test desk",
      hosts: () => ["127.0.0.1"],
      onChange: () => {
        changes += 1;
      },
    });
    port = await gateway.start({ port: 0, host: "127.0.0.1" });
  });

  afterEach(async () => {
    await gateway.stop();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function pairPhone(phone = generateKeyPair(random)) {
    const pending = pairing.open();
    const session = await openRemoteSession({
      url: remoteUrl("127.0.0.1", port),
      serverPublicKey: (await store.keyPair()).publicKey,
      clientStatic: phone,
      target: {
        mode: "pair",
        pairingId: pending.pairingId,
        pairingSecret: pending.secret,
        deviceName: "Pixel\u0007 9",
      },
      random,
      createSocket,
    });
    return { session, phone, pending };
  }

  async function resume(phone: ReturnType<typeof generateKeyPair>, deviceId: string, credential: string) {
    return openRemoteSession({
      url: remoteUrl("127.0.0.1", port),
      serverPublicKey: (await store.keyPair()).publicKey,
      clientStatic: phone,
      target: { mode: "resume", deviceId, credential: fromBase64Url(credential) },
      random,
      createSocket,
    });
  }

  function failure(promise: Promise<unknown>) {
    return promise.then(
      () => "connected",
      (error: RemoteConnectError) => error.failure,
    );
  }

  it("pairs a phone, stores only the credential hash, and relays the runtime", async () => {
    const { session } = await pairPhone();
    expect(session.paired?.deviceId).toBeTruthy();
    expect(session.ready).toMatchObject({ type: "gateway.ready", desktopName: "Test desk", environmentId, port });

    const devices = store.devices();
    expect(devices).toHaveLength(1);
    expect(devices[0]?.name).toBe("Pixel 9");
    const file = await readFile(join(directory, "mobile.json"), "utf8");
    expect(file).not.toContain(session.paired?.credential ?? "missing");
    if (process.platform !== "win32") expect((await stat(join(directory, "mobile.json"))).mode & 0o077).toBe(0);

    const hello = nextMessage(session, (message) => message.type === "hello");
    session.transport.send({ type: "hello", protocolVersion: 1, token: "phone", environmentId });
    expect((await hello).type).toBe("hello");
    expect(runtime.tokens).toEqual(["runtime-token"]);

    const response = nextMessage(session, (message) => message.type === "response");
    session.transport.send({
      type: "command",
      request: { protocolVersion: 1, commandId, command: { type: "thread.send", threadId, text: "hi" } },
    });
    expect(await response).toMatchObject({ response: { commandId, accepted: true } });
    expect(gateway.connectedDeviceIds().has(session.paired?.deviceId ?? "")).toBe(true);
    session.transport.close();
  });

  it("answers blocked commands itself and never forwards them", async () => {
    const { session } = await pairPhone();
    const response = nextMessage(session, (message) => message.type === "response");
    session.transport.send({
      type: "command",
      request: { protocolVersion: 1, commandId, command: { type: "project.register", path: "/etc" } },
    });
    expect(await response).toMatchObject({
      response: { commandId, accepted: false, error: { code: "unauthorized" } },
    });
    expect(runtime.received.some((message) => (message as { type: string }).type === "command")).toBe(false);
    session.transport.close();
  });

  it("closes the connection on a message outside the runtime protocol", async () => {
    const { session } = await pairPhone();
    const code = closed(session);
    session.transport.send({ type: "files.read", path: "/etc/passwd" });
    expect(await code).toBe(4000);
  });

  it("uses a pairing code once", async () => {
    const { pending } = await pairPhone();
    const second = openRemoteSession({
      url: remoteUrl("127.0.0.1", port),
      serverPublicKey: (await store.keyPair()).publicKey,
      clientStatic: generateKeyPair(random),
      target: { mode: "pair", pairingId: pending.pairingId, pairingSecret: pending.secret, deviceName: "Other" },
      random,
      createSocket,
    });
    expect(await failure(second)).toBe("pairing-code");
    expect(store.devices()).toHaveLength(1);
  });

  it("refuses an expired pairing code", async () => {
    const pending = pairing.open();
    now += 5 * 60_000 + 1;
    const attempt = openRemoteSession({
      url: remoteUrl("127.0.0.1", port),
      serverPublicKey: (await store.keyPair()).publicKey,
      clientStatic: generateKeyPair(random),
      target: { mode: "pair", pairingId: pending.pairingId, pairingSecret: pending.secret, deviceName: "Late" },
      random,
      createSocket,
    });
    expect(await failure(attempt)).toBe("pairing-code");
    expect(store.devices()).toHaveLength(0);
  });

  it("refuses a wrong pairing secret and withdraws the code after repeated guesses", async () => {
    const pending = pairing.open();
    const guess = () =>
      store.keyPair().then((pair) =>
        failure(
          openRemoteSession({
            url: remoteUrl("127.0.0.1", port),
            serverPublicKey: pair.publicKey,
            clientStatic: generateKeyPair(random),
            target: { mode: "pair", pairingId: pending.pairingId, pairingSecret: random(32), deviceName: "Guess" },
            random,
            createSocket,
          }),
        ),
      );
    expect(await guess()).toBe("handshake");
    for (let attempt = 0; attempt < 4; attempt += 1) await guess();
    expect(pairing.current()).toBeUndefined();
    expect(store.devices()).toHaveLength(0);
  });

  it("resumes with the stored credential and refuses a wrong one or another phone's key", async () => {
    const { session, phone } = await pairPhone();
    const { deviceId, credential } = session.paired ?? { deviceId: "", credential: "" };
    session.transport.close();

    const resumed = await resume(phone, deviceId, credential);
    expect(resumed.paired).toBeUndefined();
    expect(resumed.ready.type).toBe("gateway.ready");
    resumed.transport.close();

    expect(await failure(resume(phone, deviceId, toBase64Url(random(32))))).toBe("not-paired");
    expect(await failure(resume(generateKeyPair(random), deviceId, credential))).toBe("not-paired");
    expect(await failure(resume(phone, toBase64Url(random(16)), credential))).toBe("not-paired");
  });

  it("closes a revoked phone's live connection and refuses it afterwards", async () => {
    const { session, phone } = await pairPhone();
    const { deviceId, credential } = session.paired ?? { deviceId: "", credential: "" };
    const code = closed(session);
    await store.removeDevice(deviceId);
    gateway.disconnect(deviceId);
    expect(await code).toBe(4003);
    expect(await failure(resume(phone, deviceId, credential))).toBe("not-paired");
  });

  it("forgets a phone that asks to unpair", async () => {
    const { session } = await pairPhone();
    const code = closed(session);
    session.transport.send({ type: "gateway.unpair" });
    expect(await code).toBe(4003);
    expect(store.devices()).toHaveLength(0);
  });

  it("tells the phone to try again when the runtime connection drops", async () => {
    const { session } = await pairPhone();
    const code = closed(session);
    runtime.dropAll();
    expect(await code).toBe(1013);
  });

  it("closes a connection whose hello does not parse", async () => {
    const pending = pairing.open();
    const socket = new WebSocket(remoteUrl("127.0.0.1", port));
    const code = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
    await new Promise((resolve) => socket.addEventListener("open", resolve));
    socket.send(JSON.stringify({ type: "hello", mode: "pair", pairingId: pending.pairingId }));
    expect(await code).toBe(4000);
    expect(changes).toBe(0);
  });

  it("stops listening when phone access is turned off", async () => {
    const { session } = await pairPhone();
    const code = closed(session);
    await gateway.stop();
    expect(await code).toBe(1001);
    expect(gateway.listening).toBe(false);
  });
});
