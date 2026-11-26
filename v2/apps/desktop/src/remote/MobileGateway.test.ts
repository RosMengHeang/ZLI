import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type CreateWebSocket,
  fromBase64Url,
  generateKeyPair,
  openRemoteSession,
  RemoteCloseCode,
  type RemoteConnectError,
  type RemoteSession,
  webCryptoRandomBytes as random,
  remoteUrl,
  toBase64Url,
  type WebSocketLike,
} from "@zli-v2/remote-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ClientOptions, type RawData, WebSocketServer, WebSocket as WsSocket } from "ws";

import { MobileAccessStore, type SecretCodec } from "./MobileAccessStore.js";
import {
  MobileGateway,
  type MobileGatewayOptions,
  PAIRING_APPROVAL_WAIT_MS,
  PHONE_SOCKET_OPTIONS,
} from "./MobileGateway.js";
import { PairingWindow } from "./PairingWindow.js";

const environmentId = "00000000-0000-4000-8000-000000000001";
const projectId = "40000000-0000-4000-8000-000000000001";
const worktreeId = "50000000-0000-4000-8000-000000000001";
const threadId = "60000000-0000-4000-8000-000000000001";
const commandId = "10000000-0000-4000-8000-000000000001";
const otherCommandId = "10000000-0000-4000-8000-000000000002";
const thirdCommandId = "10000000-0000-4000-8000-000000000003";
const terminalId = "70000000-0000-4000-8000-000000000001";

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

/** Set by a test to make the relay stand-in close like the real relay does. */
let relayDropsCloseCodes = false;

/**
 * A stand-in for the byte relay. A phone dials /phone?client=<key>; the relay then dials itself at /desktop, as the
 * desktop would, hands that outbound socket to `onDesktop`, and pipes frames between the two once it is accepted.
 * /bare gives a plain socket pair with nothing piped.
 */
async function fakeRelay(onDesktop: (socket: WsSocket, client: string) => void) {
  // Offers compression, so only the desktop's own socket options keep it off.
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: true });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const waiting = new Map<string, (socket: WsSocket) => void>();
  let next = 0;
  const forward = (to: WsSocket, data: RawData, isBinary: boolean) => {
    if (to.readyState === WsSocket.OPEN) to.send(data, { binary: isBinary });
  };
  const closeWith = (socket: WsSocket, code: number) => {
    try {
      // The real relay closes the other side with a plain code, whatever the desktop used.
      socket.close(relayDropsCloseCodes ? 1000 : code);
    } catch {
      socket.close();
    }
  };
  server.on("connection", (socket, request) => {
    const url = new URL(request.url ?? "/", "http://relay");
    if (url.pathname !== "/phone") {
      waiting.get(url.searchParams.get("id") ?? "")?.(socket);
      return;
    }
    const client = url.searchParams.get("client") ?? "";
    const id = String(next++);
    const queued: Array<[RawData, boolean]> = [];
    let peer: WsSocket | undefined;
    socket.on("message", (data, isBinary) => {
      if (peer) forward(peer, data, isBinary);
      else queued.push([data, isBinary]);
    });
    const far = new Promise<WsSocket>((resolve) => waiting.set(id, resolve));
    const desktop = new WsSocket(`ws://127.0.0.1:${port}/desktop?id=${id}`, PHONE_SOCKET_OPTIONS);
    const opened = new Promise<void>((resolve) => desktop.once("open", () => resolve()));
    void Promise.all([far, opened]).then(([other]) => {
      waiting.delete(id);
      other.on("message", (data, isBinary) => forward(socket, data, isBinary));
      other.on("close", (code) => closeWith(socket, code));
      socket.on("close", () => other.close());
      onDesktop(desktop, client);
      peer = other;
      for (const [data, isBinary] of queued.splice(0)) forward(other, data, isBinary);
    });
  });
  return {
    phoneUrl: (client: string) => `ws://127.0.0.1:${port}/phone?client=${encodeURIComponent(client)}`,
    /** An open desktop-side socket and the relay's end of it. */
    bare: async (options: ClientOptions = PHONE_SOCKET_OPTIONS) => {
      const id = String(next++);
      const far = new Promise<WsSocket>((resolve) => waiting.set(id, resolve));
      const desktop = new WsSocket(`ws://127.0.0.1:${port}/bare?id=${id}`, options);
      await new Promise<void>((resolve) => desktop.once("open", () => resolve()));
      return { desktop, far: await far };
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  };
}

function closeCode(socket: WsSocket) {
  return new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
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

async function until(check: () => boolean): Promise<void> {
  for (let index = 0; index < 400 && !check(); index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
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
  let relay: Awaited<ReturnType<typeof fakeRelay>>;
  let changes = 0;
  let now = Date.now();
  let gatewayOptions: MobileGatewayOptions;

  /** Restarts the gateway with other options. The relay stand-in hands sockets to whichever gateway is current. */
  async function restartGateway(extra: Partial<MobileGatewayOptions>) {
    await gateway.stop();
    gateway = new MobileGateway({ ...gatewayOptions, ...extra });
    port = await gateway.start({ port: 0, host: "127.0.0.1" });
  }

  beforeEach(async () => {
    relayDropsCloseCodes = false;
    directory = await mkdtemp(join(tmpdir(), "zli-mobile-"));
    runtime = await fakeRuntime();
    store = new MobileAccessStore(join(directory, "mobile.json"), plainCodec, random);
    await store.load();
    now = Date.now();
    pairing = new PairingWindow(random, () => now);
    changes = 0;
    gatewayOptions = {
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
        reviews: [
          {
            worktreeId: worktreeId as never,
            baseRef: "HEAD",
            branch: "fix",
            state: "changes",
            files: [{ path: "src/app.ts", kind: "modified", staged: false, additions: 2, deletions: 1, binary: false }],
            conflictFiles: [],
            updatedAt: "2026-10-28T09:40:00.000Z",
          },
        ],
      }),
      desktopName: () => "Test desk",
      hosts: () => ["127.0.0.1"],
      onChange: () => {
        changes += 1;
      },
    };
    gateway = new MobileGateway(gatewayOptions);
    port = await gateway.start({ port: 0, host: "127.0.0.1" });
    relay = await fakeRelay((socket, client) => gateway.accept(socket, { route: "relay", client }));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await gateway.stop();
    await relay.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function pairPhone(
    phone = generateKeyPair(random),
    extra: {
      url?: string;
      onWaiting?: () => void;
      signal?: AbortSignal;
      deviceName?: string;
      createSocket?: CreateWebSocket;
    } = {},
  ) {
    const pending = pairing.open();
    const session = await openRemoteSession({
      url: extra.url ?? remoteUrl("127.0.0.1", port),
      serverPublicKey: (await store.keyPair()).publicKey,
      clientStatic: phone,
      target: {
        mode: "pair",
        pairingId: pending.pairingId,
        pairingSecret: pending.secret,
        deviceName: extra.deviceName ?? "Pixel\u0007 9",
      },
      random,
      createSocket: extra.createSocket ?? createSocket,
      ...(extra.onWaiting ? { onWaiting: extra.onWaiting } : {}),
      ...(extra.signal ? { signal: extra.signal } : {}),
    });
    return { session, phone, pending };
  }

  async function resume(
    phone: ReturnType<typeof generateKeyPair>,
    deviceId: string,
    credential: string,
    url = remoteUrl("127.0.0.1", port),
  ) {
    return openRemoteSession({
      url,
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

  it("forwards the diff of a changed file and answers a request for any other file itself", async () => {
    const { session } = await pairPhone();
    const diffId = "10000000-0000-4000-8000-000000000002";
    const forwarded = nextMessage(session, (message) => message.type === "response");
    session.transport.send({
      type: "command",
      request: {
        protocolVersion: 1,
        commandId: diffId,
        command: { type: "files.diff", worktreeId, path: "src/app.ts" },
      },
    });
    expect(await forwarded).toMatchObject({ response: { commandId: diffId, accepted: true } });

    const refused = nextMessage(session, (message) => message.type === "response");
    session.transport.send({
      type: "command",
      request: { protocolVersion: 1, commandId, command: { type: "files.diff", worktreeId, path: ".env" } },
    });
    expect(await refused).toMatchObject({
      response: {
        commandId,
        accepted: false,
        error: { code: "unauthorized", message: "Phones read diffs of changed files only." },
      },
    });
    const sent = runtime.received.filter((message) => (message as { type: string }).type === "command");
    expect(sent.map((message) => (message as { request: { commandId: string } }).request.commandId)).toEqual([diffId]);
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

  it("keeps the push token a phone sends, and forgets it when the phone turns notifications off", async () => {
    const { session } = await pairPhone();
    expect(session.ready.push).toBe(true);
    const deviceId = session.paired?.deviceId ?? "";
    const token = "ExponentPushToken[abc123]";
    session.transport.send({ type: "gateway.push", token, platform: "android" });
    await until(() => store.device(deviceId)?.push !== undefined);
    expect(store.device(deviceId)?.push).toEqual({ token, platform: "android" });

    session.transport.send({ type: "gateway.push", token: null, platform: "android" });
    await until(() => store.device(deviceId)?.push === undefined);
    session.transport.close();
  });

  it("closes the connection on a push token that is not an Expo one", async () => {
    const { session } = await pairPhone();
    const code = closed(session);
    session.transport.send({ type: "gateway.push", token: "https://example.com/hook", platform: "ios" });
    expect(await code).toBe(4000);
    expect(store.devices()[0]?.push).toBeUndefined();
  });

  it("counts a phone whose app left the screen as connected but not watching", async () => {
    const { session } = await pairPhone();
    const deviceId = session.paired?.deviceId ?? "";
    expect(gateway.attentiveDeviceIds().has(deviceId)).toBe(true);
    session.transport.send({ type: "gateway.away", away: true });
    await until(() => !gateway.attentiveDeviceIds().has(deviceId));
    expect(gateway.connectedDeviceIds().has(deviceId)).toBe(true);
    session.transport.send({ type: "gateway.away", away: false });
    await until(() => gateway.attentiveDeviceIds().has(deviceId));
    const code = closed(session);
    session.transport.close();
    await code;
    await until(() => !gateway.connectedDeviceIds().has(deviceId));
    expect(gateway.attentiveDeviceIds().size).toBe(0);
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

  it("cuts off an unpaired connection that sends a large frame before it arrives whole", async () => {
    const socket = new WebSocket(remoteUrl("127.0.0.1", port));
    const closedAt = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve()));
    await new Promise((resolve) => socket.addEventListener("open", resolve));
    socket.send(new Uint8Array(4 * 1024 * 1024));
    await closedAt;
    // The gateway still pairs phones afterwards.
    const { session } = await pairPhone();
    expect(session).toBeDefined();
  });

  describe("over the relay", () => {
    async function pairedPhone() {
      const { session, phone } = await pairPhone();
      const { deviceId, credential } = session.paired ?? { deviceId: "", credential: "" };
      session.transport.close();
      return { phone, deviceId, credential };
    }

    it("resumes a paired phone and relays the runtime, as on the LAN", async () => {
      const { phone, deviceId, credential } = await pairedPhone();
      const session = await resume(phone, deviceId, credential, relay.phoneUrl("phone-a"));
      expect(session.ready).toMatchObject({ type: "gateway.ready", desktopName: "Test desk", environmentId });
      expect(gateway.connectedDeviceIds().has(deviceId)).toBe(true);

      const response = nextMessage(session, (message) => message.type === "response");
      session.transport.send({
        type: "command",
        request: { protocolVersion: 1, commandId, command: { type: "thread.send", threadId, text: "hi" } },
      });
      expect(await response).toMatchObject({ response: { commandId, accepted: true } });

      const refused = nextMessage(session, (message) => message.type === "response");
      session.transport.send({
        type: "command",
        request: { protocolVersion: 1, commandId, command: { type: "project.register", path: "/etc" } },
      });
      expect(await refused).toMatchObject({ response: { accepted: false, error: { code: "unauthorized" } } });
      session.transport.close();
    });

    it("refuses terminal input over the relay until the desktop allows it, and keeps it on the LAN", async () => {
      const { phone, deviceId, credential } = await pairedPhone();
      const write = (id: string) => ({
        type: "command",
        request: { protocolVersion: 1, commandId: id, command: { type: "terminal.write", terminalId, data: "ls\r" } },
      });
      const remote = await resume(phone, deviceId, credential, relay.phoneUrl("phone-a"));
      const refused = nextMessage(remote, (message) => message.type === "response");
      remote.transport.send(write(commandId));
      expect(await refused).toMatchObject({
        response: {
          commandId,
          accepted: false,
          error: {
            code: "unauthorized",
            message: "Terminal input from outside your network is turned off on the desktop.",
          },
        },
      });

      const local = await resume(phone, deviceId, credential);
      const forwarded = nextMessage(local, (message) => message.type === "response");
      local.transport.send(write(otherCommandId));
      expect(await forwarded).toMatchObject({ response: { commandId: otherCommandId, accepted: true } });
      local.transport.close();

      // Read on each message, so turning it on applies to the session already open.
      await store.setRelayEnabled(true);
      await store.setRemoteTerminalInput(true);
      const allowed = nextMessage(remote, (message) => message.type === "response");
      remote.transport.send(write(thirdCommandId));
      expect(await allowed).toMatchObject({ response: { commandId: thirdCommandId, accepted: true } });
      remote.transport.close();
    });

    it("refuses a wrong credential over the relay", async () => {
      const { phone, deviceId } = await pairedPhone();
      const attempt = resume(phone, deviceId, toBase64Url(random(32)), relay.phoneUrl("phone-a"));
      expect(await failure(attempt)).toBe("not-paired");
    });

    it("rate limits attempts per relay client, not across them", async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const { desktop, far } = await relay.bare();
        const gone = closeCode(desktop);
        gateway.accept(desktop, { route: "relay", client: "abc123" });
        far.close();
        await gone;
      }
      const limited = await relay.bare();
      const limitedCode = closeCode(limited.far);
      gateway.accept(limited.desktop, { route: "relay", client: "abc123" });
      expect(await limitedCode).toBe(RemoteCloseCode.rateLimited);

      const other = await relay.bare();
      const otherCode = closeCode(other.far);
      gateway.accept(other.desktop, { route: "relay", client: "def456" });
      const timeout = new Promise<string>((resolve) => setTimeout(() => resolve("still open"), 100));
      expect(await Promise.race([otherCode, timeout])).toBe("still open");
      other.far.close();
    });

    it("limits relay keys that are not plain short tokens together", async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const { desktop, far } = await relay.bare();
        const gone = closeCode(desktop);
        gateway.accept(desktop, { route: "relay", client: attempt % 2 ? "" : `bad key ${attempt}` });
        far.close();
        await gone;
      }
      const limited = await relay.bare();
      const limitedCode = closeCode(limited.far);
      gateway.accept(limited.desktop, { route: "relay", client: "x".repeat(65) });
      expect(await limitedCode).toBe(RemoteCloseCode.rateLimited);
    });

    it("holds at most four unpaired relay connections, and leaves the LAN alone", async () => {
      const sockets = await Promise.all([1, 2, 3, 4, 5].map(() => relay.bare()));
      const codes = sockets.map(({ far }) => closeCode(far));
      sockets.forEach(({ desktop }, index) => {
        gateway.accept(desktop, { route: "relay", client: `client-${index}` });
      });
      expect(await codes[4]).toBe(RemoteCloseCode.tryAgain);

      const { session } = await pairPhone();
      expect(session.ready.type).toBe("gateway.ready");
      session.transport.close();
      for (const { far } of sockets.slice(0, 4)) {
        expect(far.readyState).toBe(WsSocket.OPEN);
        far.close();
      }
    });

    it("closes a relay connection that sends a large frame before pairing", async () => {
      const { desktop, far } = await relay.bare();
      const code = closeCode(far);
      gateway.accept(desktop, { route: "relay", client: "abc123" });
      far.send(new Uint8Array(65 * 1024));
      expect(await code).toBe(RemoteCloseCode.protocol);
    });

    it("closes an open relay connection that sends a frame over the phone limit", async () => {
      const { phone, deviceId, credential } = await pairedPhone();
      const session = await resume(phone, deviceId, credential, relay.phoneUrl("phone-a"));
      const code = closed(session);
      session.transport.send({ type: "hello", protocolVersion: 1, token: "x".repeat(8 * 1024 * 1024), environmentId });
      // The socket's own frame cap answers first, with 1009, as the LAN server does.
      expect(await code).toBe(1009);
    });

    it("cuts off an oversized frame on a socket dialed with the phone socket options", async () => {
      const { desktop, far } = await relay.bare();
      const code = closeCode(far);
      gateway.accept(desktop, { route: "relay", client: "abc123" });
      far.send(new Uint8Array(PHONE_SOCKET_OPTIONS.maxPayload + 1));
      // 1009 comes from the socket's own cap, before the gateway ever holds the whole frame.
      expect(await code).toBe(1009);
    });

    it("refuses a relay socket that negotiated compression", async () => {
      const { desktop, far } = await relay.bare({});
      expect(desktop.extensions).toContain("permessage-deflate");
      const code = closeCode(far);
      gateway.accept(desktop, { route: "relay", client: "abc123" });
      expect(await code).toBe(RemoteCloseCode.protocol);
    });

    it("cuts off a compressed relay socket after refusing it", async () => {
      const { desktop, far } = await relay.bare({});
      far.pause();
      gateway.accept(desktop, { route: "relay", client: "abc123" });
      // The peer never answers the close, so only terminate() gets it to CLOSED quickly.
      await until(() => desktop.readyState === WsSocket.CLOSED);
    });

    it("drops a relay socket that is not open yet", async () => {
      const connecting = new WsSocket("ws://127.0.0.1:9/never", PHONE_SOCKET_OPTIONS);
      connecting.on("error", () => undefined);
      expect(connecting.readyState).toBe(WsSocket.CONNECTING);
      expect(() => gateway.accept(connecting, { route: "relay", client: "abc123" })).not.toThrow();
      await until(() => connecting.readyState === WsSocket.CLOSED);
    });

    it("lets stop() cut off a refused relay socket that is still closing", async () => {
      const held = await Promise.all([1, 2, 3, 4].map(() => relay.bare()));
      held.forEach(({ desktop }, index) => {
        gateway.accept(desktop, { route: "relay", client: `held-${index}` });
      });
      const refused = await relay.bare();
      // The relay end never answers the close, so the socket would sit closing until ws gives up on it.
      refused.far.pause();
      gateway.accept(refused.desktop, { route: "relay", client: "refused" });
      expect(refused.desktop.readyState).toBe(WsSocket.CLOSING);
      await gateway.stop();
      await until(() => refused.desktop.readyState === WsSocket.CLOSED);
    });

    it("refuses relay sockets while phone access is off", async () => {
      await gateway.stop();
      const { desktop, far } = await relay.bare();
      const code = closeCode(far);
      gateway.accept(desktop, { route: "relay", client: "abc123" });
      expect(await code).toBe(RemoteCloseCode.tryAgain);
    });

    it("closes a relay session when its phone is revoked", async () => {
      const { phone, deviceId, credential } = await pairedPhone();
      const session = await resume(phone, deviceId, credential, relay.phoneUrl("phone-a"));
      const code = closed(session);
      await store.removeDevice(deviceId);
      gateway.disconnect(deviceId);
      expect(await code).toBe(RemoteCloseCode.notPaired);
    });

    it("closes relay sessions when phone access is turned off", async () => {
      const { phone, deviceId, credential } = await pairedPhone();
      const session = await resume(phone, deviceId, credential, relay.phoneUrl("phone-a"));
      const code = closed(session);
      await gateway.stop();
      expect(await code).toBe(1001);
    });
  });

  describe("pairing over the relay", () => {
    type Ask = { deviceName: string; route: "lan" | "relay"; signal: AbortSignal };

    /** An approvePairing that records each request and lets the test answer it. */
    function approver() {
      const asked: Array<Ask & { answer: (allow: boolean) => void }> = [];
      const approvePairing = vi.fn(
        (request: Ask) => new Promise<boolean>((resolve) => asked.push({ ...request, answer: resolve })),
      );
      return { asked, approvePairing };
    }

    function pairOverRelay(extra: Parameters<typeof pairPhone>[1] = {}) {
      return pairPhone(undefined, { url: relay.phoneUrl("phone-a"), ...extra });
    }

    it("holds the pairing until the desktop allows it, then stores the phone", async () => {
      const { asked, approvePairing } = approver();
      await restartGateway({ approvePairing });
      let waited = false;
      const attempt = pairOverRelay({
        onWaiting: () => {
          waited = true;
        },
      });
      await until(() => asked.length === 1);
      expect(asked[0]).toMatchObject({ deviceName: "Pixel 9", route: "relay" });
      await until(() => waited);
      expect(store.devices()).toEqual([]);

      asked[0]?.answer(true);
      const { session } = await attempt;
      expect(session.paired?.deviceId).toBeTruthy();
      expect(store.devices().map((device) => device.name)).toEqual(["Pixel 9"]);
      session.transport.close();
    });

    it("drops direction controls from the name it asks about, so they cannot reorder the prompt", async () => {
      const { asked, approvePairing } = approver();
      await restartGateway({ approvePairing });
      const attempt = pairOverRelay({ deviceName: "Pixel\u202e 9\u2066\u200f \u{1F469}\u200d\u{1F4BB}\u2069" });
      await until(() => asked.length === 1);
      // The emoji's zero-width joiner stays.
      expect(asked[0]?.deviceName).toBe("Pixel 9 \u{1F469}\u200d\u{1F4BB}");
      asked[0]?.answer(true);
      const { session } = await attempt;
      expect(store.devices()[0]?.name).toBe("Pixel 9 \u{1F469}\u200d\u{1F4BB}");
      session.transport.close();
    });

    it("removes the phone again when it leaves while the desktop is still storing it", async () => {
      const { asked, approvePairing } = approver();
      await restartGateway({ approvePairing });
      const add = store.addDevice.bind(store);
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let adding = false;
      vi.spyOn(store, "addDevice").mockImplementation(async (device) => {
        adding = true;
        await held;
        return add(device);
      });
      const controller = new AbortController();
      const attempt = failure(pairOverRelay({ signal: controller.signal }));
      await until(() => asked.length === 1);
      asked[0]?.answer(true);
      await until(() => adding);
      controller.abort();
      expect(await attempt).toBe("network");
      await new Promise((resolve) => setTimeout(resolve, 20));
      release();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(store.devices()).toEqual([]);
    });

    it("says it is still waiting every 20 seconds, and stops once allowed or closed", async () => {
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
        shouldAdvanceTime: true,
      });
      const { asked, approvePairing } = approver();
      await restartGateway({ approvePairing });
      const frames = { count: 0 };
      const counting: CreateWebSocket = (url) => {
        const socket = new WebSocket(url);
        socket.addEventListener("message", (event) => {
          if (typeof event.data !== "string") frames.count += 1;
        });
        return socket as unknown as WebSocketLike;
      };
      let waited = false;
      const attempt = pairOverRelay({
        createSocket: counting,
        onWaiting: () => {
          waited = true;
        },
      });
      await until(() => waited);
      expect(frames.count).toBe(1);
      await vi.advanceTimersByTimeAsync(20_000);
      await until(() => frames.count === 2);
      await vi.advanceTimersByTimeAsync(20_000);
      await until(() => frames.count === 3);
      asked[0]?.answer(true);
      const { session } = await attempt;
      // paired, then ready.
      await until(() => frames.count === 5);
      await vi.advanceTimersByTimeAsync(20_000);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(frames.count).toBe(5);
      session.transport.close();

      const second = approver();
      await restartGateway({ approvePairing: second.approvePairing });
      // The gateway's own heartbeat.
      const idle = vi.getTimerCount();
      const closing = new AbortController();
      const left = failure(pairOverRelay({ signal: closing.signal }));
      await until(() => second.asked.length === 1);
      closing.abort();
      expect(await left).toBe("network");
      await until(() => second.asked[0]?.signal.aborted === true);
      await new Promise((resolve) => setTimeout(resolve, 30));
      // The repeat and the approval deadline are both gone.
      expect(vi.getTimerCount()).toBe(idle);
    });

    it("tells the phone sealed that it was refused, for a relay that drops close codes", async () => {
      relayDropsCloseCodes = true;
      // Nothing can ask the person, so the phone is refused before any wait; only the sealed message says why.
      const attempt = pairOverRelay().then(
        () => "connected",
        (error: RemoteConnectError) => [error.failure, error.message],
      );
      expect(await attempt).toEqual([
        "pairing-denied",
        "The PC didn't allow this phone. Make a new code on the PC and try again.",
      ]);
    });

    it("tells the phone sealed that nobody answered in time", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      relayDropsCloseCodes = true;
      const { approvePairing } = approver();
      await restartGateway({ approvePairing });
      let waited = false;
      const attempt = pairOverRelay({
        onWaiting: () => {
          waited = true;
        },
      }).then(
        () => "connected",
        (error: RemoteConnectError) => [error.failure, error.message],
      );
      await until(() => waited);
      await vi.advanceTimersByTimeAsync(PAIRING_APPROVAL_WAIT_MS);
      expect(await attempt).toEqual([
        "pairing-denied",
        "The PC didn't answer in time. Make a new code on the PC and try again.",
      ]);
    });

    it("refuses the pairing and stores nothing when the desktop does not allow it", async () => {
      const { asked, approvePairing } = approver();
      await restartGateway({ approvePairing });
      const attempt = failure(pairOverRelay());
      await until(() => asked.length === 1);
      asked[0]?.answer(false);
      expect(await attempt).toBe("pairing-denied");
      expect(store.devices()).toEqual([]);
    });

    it("refuses the pairing when nobody answers in time", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      const { asked, approvePairing } = approver();
      await restartGateway({ approvePairing });
      let waited = false;
      const attempt = failure(
        pairOverRelay({
          onWaiting: () => {
            waited = true;
          },
        }),
      );
      // The phone's own deadline moves only once it hears the desktop is waiting.
      await until(() => waited);
      await vi.advanceTimersByTimeAsync(PAIRING_APPROVAL_WAIT_MS - 1_000);
      expect(asked[0]?.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await attempt).toBe("pairing-denied");
      expect(asked[0]?.signal.aborted).toBe(true);
      // A late answer changes nothing.
      asked[0]?.answer(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(store.devices()).toEqual([]);
    });

    it("cancels the request when the phone leaves while it waits", async () => {
      const { asked, approvePairing } = approver();
      await restartGateway({ approvePairing });
      const controller = new AbortController();
      const attempt = failure(pairOverRelay({ signal: controller.signal }));
      await until(() => asked.length === 1);
      controller.abort();
      expect(await attempt).toBe("network");
      await until(() => asked[0]?.signal.aborted === true);
      asked[0]?.answer(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(store.devices()).toEqual([]);
    });

    it("closes a waiting connection that sends anything more", async () => {
      const { asked, approvePairing } = approver();
      await restartGateway({ approvePairing });
      const pending = pairing.open();
      let socket: WebSocketLike | undefined;
      const attempt = failure(
        openRemoteSession({
          url: relay.phoneUrl("phone-a"),
          serverPublicKey: (await store.keyPair()).publicKey,
          clientStatic: generateKeyPair(random),
          target: { mode: "pair", pairingId: pending.pairingId, pairingSecret: pending.secret, deviceName: "Pixel" },
          random,
          createSocket: (url) => {
            socket = createSocket(url);
            return socket;
          },
          onWaiting: () => socket?.send(new ArrayBuffer(40)),
        }),
      );
      await until(() => asked.length === 1);
      expect(await attempt).toBe("protocol");
      expect(asked[0]?.signal.aborted).toBe(true);
      expect(store.devices()).toEqual([]);
    });

    it("still counts a waiting connection as unpaired", async () => {
      const { asked, approvePairing } = approver();
      await restartGateway({ approvePairing });
      const attempt = failure(pairOverRelay());
      await until(() => asked.length === 1);
      const sockets = await Promise.all([1, 2, 3, 4].map(() => relay.bare()));
      const codes = sockets.map(({ far }) => closeCode(far));
      sockets.forEach(({ desktop }, index) => {
        gateway.accept(desktop, { route: "relay", client: `client-${index}` });
      });
      expect(await codes[3]).toBe(RemoteCloseCode.tryAgain);
      for (const { far } of sockets.slice(0, 3)) far.close();
      asked[0]?.answer(false);
      expect(await attempt).toBe("pairing-denied");
    });

    it("never asks for a pairing on the LAN", async () => {
      const { approvePairing } = approver();
      await restartGateway({ approvePairing });
      const { session } = await pairPhone();
      expect(session.paired?.deviceId).toBeTruthy();
      expect(approvePairing).not.toHaveBeenCalled();
      expect(store.devices()).toHaveLength(1);
      session.transport.close();
    });

    it("refuses relay pairings when nothing can ask the person", async () => {
      expect(await failure(pairOverRelay())).toBe("pairing-denied");
      expect(store.devices()).toEqual([]);
    });
  });

  it("stops listening when phone access is turned off", async () => {
    const { session } = await pairPhone();
    const code = closed(session);
    await gateway.stop();
    expect(await code).toBe(1001);
    expect(gateway.listening).toBe(false);
  });
});
